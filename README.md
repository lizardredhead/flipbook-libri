# Flipbook statico PDF → WebP per GitHub Pages

Questa struttura permette di pubblicare libri/PDF su GitHub Pages senza far renderizzare il PDF al browser dell'utente.

Il flusso è:

1. carichi un PDF in `books/NOME_LIBRO/documento.pdf`;
2. fai commit e push;
3. GitHub Actions converte automaticamente il PDF in immagini WebP;
4. il viewer legge `manifest.json` e carica solo le pagine necessarie con lazy loading.

Esempi URL finali:

```text
viewer.html?book=libro-1
viewer.html?book=libro-2
```

Su GitHub Pages, se il repository si chiama `mio-repo`, il link sarà simile a:

```text
https://NOME_UTENTE.github.io/mio-repo/viewer.html?book=libro-1
```

---

## Struttura del repository

```text
/
  viewer.html
  package.json
  README.md
  scripts/
    build-book.js
  .github/
    workflows/
      build-books.yml
  books/
    libro-1/
      documento.pdf
      manifest.json
      pages/
        page-001.webp
        page-002.webp
        page-003.webp
    libro-2/
      documento.pdf
      manifest.json
      pages/
        page-001.webp
```

`manifest.json` e la cartella `pages/` vengono generati automaticamente. Non devi crearli manualmente.

---

## Come aggiungere un nuovo libro

### 1. Crea la cartella del libro

Dentro `books/`, crea una cartella con un nome semplice, ad esempio:

```text
books/libro-1/
```

Usa nomi senza spazi, ad esempio:

```text
libro-1
manuale-tecnico
catalogo-2026
```

Evita nomi con slash, accenti o caratteri speciali.

---

### 2. Inserisci il PDF

Metti il PDF dentro la cartella del libro e chiamalo esattamente:

```text
documento.pdf
```

Esempio:

```text
books/libro-1/documento.pdf
```

Il PDF originale può restare nel repository, ma il viewer non lo usa direttamente: il viewer carica le pagine WebP generate.

---

### 3. Fai commit e push

Esempio da terminale:

```bash
git add books/libro-1/documento.pdf
git commit -m "Add libro-1"
git push
```

---

### 4. Attendi l'esecuzione automatica

Dopo il push, GitHub Actions avvia il workflow:

```text
.github/workflows/build-books.yml
```

Il workflow:

1. installa Node.js;
2. installa `poppler-utils` e `webp`;
3. esegue `npm install`;
4. esegue `npm run build-books`;
5. genera le pagine WebP;
6. aggiorna `manifest.json`;
7. fa commit automatico dei file generati.

Al termine troverai, per esempio:

```text
books/libro-1/manifest.json
books/libro-1/pages/page-001.webp
books/libro-1/pages/page-002.webp
books/libro-1/pages/page-003.webp
```

---

## Come aprire un libro

Apri il viewer passando il nome della cartella nel parametro `book`.

Esempi:

```text
viewer.html?book=libro-1
viewer.html?book=libro-2
```

Esempio completo su GitHub Pages:

```text
https://NOME_UTENTE.github.io/NOME_REPOSITORY/viewer.html?book=libro-1
```

---

## Come aggiornare un libro esistente

Sostituisci il file:

```text
books/libro-1/documento.pdf
```

poi fai commit e push:

```bash
git add books/libro-1/documento.pdf
git commit -m "Update libro-1"
git push
```

Lo script calcola una hash SHA-256 del PDF. Se il PDF non è cambiato e le pagine WebP sono già presenti, la conversione viene saltata.

Se il PDF cambia, vengono rigenerate le pagine e aggiornato `manifest.json`.

---

## Conversione locale facoltativa

La conversione avviene automaticamente su GitHub Actions, quindi in genere non serve farla in locale.

Se però vuoi testare prima sul tuo computer, installa gli strumenti richiesti.

### Ubuntu / WSL

```bash
sudo apt-get update
sudo apt-get install -y poppler-utils webp
npm install --package-lock=false
npm run build-books
```

### macOS con Homebrew

```bash
brew install poppler webp
npm install --package-lock=false
npm run build-books
```

Su Windows è consigliato usare WSL oppure lasciare che la conversione venga eseguita direttamente da GitHub Actions.

---

## Parametri di qualità

Lo script usa valori bilanciati:

```text
DPI = 140
WEBP_QUALITY = 78
WEBP_METHOD = 5
```

Puoi modificarli tramite variabili d'ambiente nel workflow:

```yaml
env:
  BOOK_DPI: 120
  WEBP_QUALITY: 72
  WEBP_METHOD: 5
```

Riduci `BOOK_DPI` e `WEBP_QUALITY` se le immagini sono troppo pesanti.

---

## GitHub Pages

Per pubblicare il sito:

1. vai nelle impostazioni del repository;
2. apri **Pages**;
3. scegli il branch principale, ad esempio `main`;
4. scegli la cartella root `/` come sorgente;
5. salva.

Dopo la pubblicazione, usa il link GitHub Pages del repository e aggiungi:

```text
/viewer.html?book=NOME_LIBRO
```

---

## Note sui limiti pratici

GitHub Pages è gratuito e va bene per siti statici leggeri, ma non è pensato come archivio massivo di migliaia di immagini pesanti.

Se il sito cresce troppo, usa una o più di queste strategie:

1. riduci `BOOK_DPI`, ad esempio da `140` a `120`;
2. riduci `WEBP_QUALITY`, ad esempio da `78` a `70`;
3. dividi i libri in più repository GitHub Pages, ad esempio uno per categoria o anno;
4. evita di caricare PDF enormi non necessari;
5. mantieni nel repository solo i libri effettivamente pubblicati.

Evita Git LFS per questo caso: GitHub Pages deve poter servire direttamente i file statici generati.

---

## Manifest generato

Ogni libro ha un file `manifest.json` simile a questo:

```json
{
  "title": "libro-1",
  "pdf": "documento.pdf",
  "pageCount": 120,
  "format": "webp",
  "pagesPath": "pages",
  "pagePattern": "page-{n}.webp",
  "hash": "...",
  "generatedAt": "..."
}
```

Il viewer usa questo manifest per sapere quante pagine esistono e dove trovare le immagini.
