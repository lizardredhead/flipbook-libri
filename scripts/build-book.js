#!/usr/bin/env node

/**
 * build-book.js
 *
 * Converte automaticamente i PDF presenti in /books/<nome-libro>/documento.pdf
 * in pagine WebP ottimizzate per un viewer statico su GitHub Pages.
 *
 * Requisiti di sistema:
 * - poppler-utils: pdfinfo, pdftoppm
 * - webp: cwebp
 *
 * Note:
 * - Lo script evita la riconversione se l'hash SHA-256 del PDF non è cambiato.
 * - La conversione PDF -> PNG viene fatta da Poppler.
 * - La conversione PNG -> WebP viene fatta da cwebp.
 * - Il viewer non usa il PDF: legge solo manifest.json e pagine WebP.
 */

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, "..");
const BOOKS_DIR = path.join(ROOT_DIR, "books");

const PDF_NAME = "documento.pdf";
const PAGES_DIR_NAME = "pages";
const MANIFEST_NAME = "manifest.json";

// Parametri bilanciati: buona leggibilità, peso contenuto.
// Puoi ridurre questi valori se il repository cresce troppo.
const DPI = Number(process.env.BOOK_DPI || 140);
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || 78);
const WEBP_METHOD = Number(process.env.WEBP_METHOD || 5);
const CWEBP_CONCURRENCY = Math.max(
  1,
  Number(process.env.CWEBP_CONCURRENCY || Math.min(4, os.cpus().length || 2))
);

function log(message) {
  console.log(`[build-books] ${message}`);
}

async function commandExists(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new Error(
      `Comando non disponibile: ${command}. Installa poppler-utils e webp. Dettaglio: ${error.message}`
    );
  }
}

async function ensureSystemTools() {
  await commandExists("pdfinfo", ["-v"]);
  await commandExists("pdftoppm", ["-v"]);
  await commandExists("cwebp", ["-version"]);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fssync.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readJsonSafe(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function padPageNumber(pageNumber, pageCount) {
  const width = Math.max(3, String(pageCount).length);
  return String(pageNumber).padStart(width, "0");
}

function pageFileName(pageNumber, pageCount) {
  return `page-${padPageNumber(pageNumber, pageCount)}.webp`;
}

async function getBookDirectories() {
  if (!(await pathExists(BOOKS_DIR))) {
    log("Cartella /books non trovata. Creo la cartella, ma non ci sono libri da convertire.");
    await fs.mkdir(BOOKS_DIR, { recursive: true });
    return [];
  }

  const entries = await fs.readdir(BOOKS_DIR, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "it"));
}

async function getPdfPageCount(pdfPath) {
  const { stdout, stderr } = await execFileAsync("pdfinfo", [pdfPath], {
    maxBuffer: 1024 * 1024 * 5,
  });

  const output = `${stdout}\n${stderr}`;
  const match = output.match(/^Pages:\s+(\d+)$/im);

  if (!match) {
    throw new Error(`Impossibile leggere il numero di pagine da pdfinfo per: ${pdfPath}`);
  }

  return Number(match[1]);
}

async function pagesComplete(bookDir, pageCount) {
  const pagesDir = path.join(bookDir, PAGES_DIR_NAME);

  if (!(await pathExists(pagesDir))) return false;

  for (let page = 1; page <= pageCount; page += 1) {
    const filePath = path.join(pagesDir, pageFileName(page, pageCount));
    if (!(await pathExists(filePath))) return false;
  }

  return true;
}

async function removeOldBuildDirs(bookDir) {
  const entries = await fs.readdir(bookDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".pages-build-"))
      .map((entry) => fs.rm(path.join(bookDir, entry.name), { recursive: true, force: true }))
  );
}

async function runLimited(items, limit, worker) {
  const queue = [...items];

  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });

  await Promise.all(workers);
}

/**
 * Poppler/pdftoppm può generare nomi leggermente diversi a seconda della versione:
 * - page-1.png
 * - page-01.png
 * - page-001.png
 * - page-000001.png
 *
 * La vecchia versione dello script cercava solo page-1.png.
 * Questa funzione invece legge davvero i file prodotti e li mappa per numero pagina.
 */
async function discoverGeneratedPngs(tmpRoot) {
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  const pngMap = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const match = entry.name.match(/^page-(\d+)\.png$/i);
    if (!match) continue;

    const pageNumber = Number.parseInt(match[1], 10);
    if (!Number.isInteger(pageNumber) || pageNumber <= 0) continue;

    pngMap.set(pageNumber, path.join(tmpRoot, entry.name));
  }

  return pngMap;
}

async function convertPdfToWebP({ bookName, bookDir, pdfPath, pageCount }) {
  const safeBookName = bookName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `book-${safeBookName}-`));
  const pngPrefix = path.join(tmpRoot, "page");
  const nextPagesDir = path.join(bookDir, `.pages-build-${Date.now()}`);
  const finalPagesDir = path.join(bookDir, PAGES_DIR_NAME);

  await removeOldBuildDirs(bookDir);
  await fs.mkdir(nextPagesDir, { recursive: true });

  try {
    log(`${bookName}: converto PDF in PNG temporanei con Poppler, DPI=${DPI}`);

    await execFileAsync(
      "pdftoppm",
      [
        "-r",
        String(DPI),
        "-png",
        "-f",
        "1",
        "-l",
        String(pageCount),
        pdfPath,
        pngPrefix,
      ],
      { maxBuffer: 1024 * 1024 * 50 }
    );

    const pngMap = await discoverGeneratedPngs(tmpRoot);

    if (pngMap.size === 0) {
      const generatedFiles = await fs.readdir(tmpRoot);
      throw new Error(
        `Poppler non ha generato PNG riconoscibili. File trovati in tmp: ${
          generatedFiles.join(", ") || "nessuno"
        }`
      );
    }

    log(`${bookName}: PNG temporanei trovati: ${pngMap.size}/${pageCount}`);

    const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);

    log(
      `${bookName}: converto ${pageCount} pagina/e in WebP, qualità=${WEBP_QUALITY}, concorrenza=${CWEBP_CONCURRENCY}`
    );

    await runLimited(pageNumbers, CWEBP_CONCURRENCY, async (page) => {
      const inputPng = pngMap.get(page);
      const outputWebp = path.join(nextPagesDir, pageFileName(page, pageCount));

      if (!inputPng) {
        const generatedFiles = await fs.readdir(tmpRoot);
        throw new Error(
          `PNG temporaneo mancante per pagina ${page}. File trovati: ${generatedFiles.join(", ")}`
        );
      }

      await execFileAsync(
        "cwebp",
        [
          "-quiet",
          "-q",
          String(WEBP_QUALITY),
          "-m",
          String(WEBP_METHOD),
          "-metadata",
          "none",
          inputPng,
          "-o",
          outputWebp,
        ],
        { maxBuffer: 1024 * 1024 * 50 }
      );
    });

    await fs.rm(finalPagesDir, { recursive: true, force: true });
    await fs.rename(nextPagesDir, finalPagesDir);
  } catch (error) {
    await fs.rm(nextPagesDir, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function buildBook(bookName) {
  const bookDir = path.join(BOOKS_DIR, bookName);
  const pdfPath = path.join(bookDir, PDF_NAME);
  const manifestPath = path.join(bookDir, MANIFEST_NAME);

  if (!(await pathExists(pdfPath))) {
    log(`${bookName}: ${PDF_NAME} non trovato, salto.`);
    return { bookName, status: "skipped-no-pdf" };
  }

  const hash = await sha256File(pdfPath);
  const previousManifest = await readJsonSafe(manifestPath);

  if (
    previousManifest?.hash === hash &&
    Number.isInteger(previousManifest.pageCount) &&
    previousManifest.pageCount > 0 &&
    (await pagesComplete(bookDir, previousManifest.pageCount))
  ) {
    log(`${bookName}: PDF invariato e pagine già presenti, salto conversione.`);
    return { bookName, status: "skipped-unchanged" };
  }

  const pageCount = await getPdfPageCount(pdfPath);

  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new Error(`${bookName}: numero pagine non valido: ${pageCount}`);
  }

  await convertPdfToWebP({ bookName, bookDir, pdfPath, pageCount });

  const manifest = {
    title: bookName,
    pdf: PDF_NAME,
    pageCount,
    format: "webp",
    pagesPath: PAGES_DIR_NAME,
    pagePattern: "page-{n}.webp",
    hash,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  log(`${bookName}: generato ${MANIFEST_NAME} e ${pageCount} pagina/e WebP.`);

  return { bookName, status: "generated", pageCount };
}

async function main() {
  await ensureSystemTools();

  const bookNames = await getBookDirectories();

  if (bookNames.length === 0) {
    log("Nessuna cartella libro trovata in /books.");
    return;
  }

  const results = [];

  for (const bookName of bookNames) {
    try {
      results.push(await buildBook(bookName));
    } catch (error) {
      console.error(`\n[build-books] ERRORE su ${bookName}: ${error.message}\n`);
      throw error;
    }
  }

  const generated = results.filter((item) => item.status === "generated").length;
  const unchanged = results.filter((item) => item.status === "skipped-unchanged").length;
  const withoutPdf = results.filter((item) => item.status === "skipped-no-pdf").length;

  log(`Fine. Generati: ${generated}, invariati: ${unchanged}, senza PDF: ${withoutPdf}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
