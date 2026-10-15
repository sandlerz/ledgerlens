# LedgerLens

**Reads Colombian payment receipts (photos and screenshots), lets you review them, and exports them to Excel. Everything runs on your Mac: free, and your data never leaves your machine.**

- **OCR** with Apple Vision (built into macOS), with automatic detection of rotated photos.
- **Local vision AI** with [Ollama](https://ollama.com) (`qwen3-vl:8b-instruct`) that understands each format: Nequi, Daviplata, Davivienda, Bancolombia app, Bre-B, Wompi/Redeban cash-agent tickets, printed bill payments, Refácil, email notifications…
- **Cross-verification**: a value is only marked as "sure" if its digits appear exactly in the text of the image. Uncertain values are highlighted in yellow and missing ones in red.
- **Payee catalog**: recognizes payees by account, Bre-B key or agreement code, even when the name is truncated ("DISTRIBUIDORA DEL N") or masked ("Dis*** Nor***"). It learns when you assign one by hand.
- **Fast review**: the image next to the extracted data, with zoom and rotation. `Enter` saves and jumps to the next one.
- **Excel export** with real dates, numeric amounts, references as text, filters and a total row.

> The app interface is in Spanish.

## Requirements

- macOS with Apple's developer tools (`xcode-select --install`)
- [Node.js](https://nodejs.org) 22 or later
- [Ollama](https://ollama.com) (optional but recommended; without it the app falls back to rule-based reading)

## Installation

```bash
cd app
npm install
ollama pull qwen3-vl:8b-instruct
```

On first start, the app compiles the OCR reader (takes about a minute).

## Usage

1. Create one folder per store inside `Comprobantes/` (for example `Comprobantes/Local Centro/`) and put the images there.
2. In one terminal, start the local AI and leave it running:

   ```bash
   ollama serve
   ```

3. In another terminal, start the app:

   ```bash
   cd app
   npm start
   ```

4. Open <http://localhost:3000>, click **Procesar nuevas** (process new), review, and download the Excel file.

To stop, press `Ctrl + C` in each terminal.

## Privacy

The images in `Comprobantes/` and the data the app generates (`app/data/`: transactions and payees with their accounts) are **never committed**; they are listed in `.gitignore`. The server only listens on `127.0.0.1`.

## Tests

```bash
cd app
npm test          # automated tests (made-up data)
npm run comparar  # accuracy against your real receipts
```

`npm run comparar` needs `app/test/verificacion/esperados.json` with the correct values for some of your receipts. Copy it from `esperados.ejemplo.json`. That file is private and is not committed.

## Project structure

```
Comprobantes/          ← your images, one subfolder per store (not committed)
app/
  server.js            ← local server (Express) and API
  ocr/ocr.swift        ← OCR with Apple Vision
  lib/extraer.js       ← per-format rules (date, amount, reference, payee)
  lib/ia.js            ← reading with the local vision model (Ollama)
  lib/verificar.js     ← cross-verification AI ↔ OCR ↔ rules
  lib/catalogo.js      ← payee catalog
  lib/excel.js         ← Excel export
  public/              ← review interface
  herramientas/        ← accuracy comparison tool
  test/                ← tests
```

## License

[MIT](LICENSE)
