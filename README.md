# PDF Editor

A small PDF editor that runs in your web browser. You don't install anything, and your files never leave your computer.

It can:

- **Type text** anywhere on a page.
- **Highlight**: drag a box over an area, or select some text and press <kbd>H</kbd>.
- **White-out**: cover existing content with a box, then type over it to "edit" what was there.
- **Draw** freehand.
- **Make searchable (OCR)**: reads the words on scanned pages so <kbd>Ctrl</kbd>+<kbd>F</kbd> (<kbd>⌘</kbd>+<kbd>F</kbd> on Mac) can find them, both in the editor and in the saved file in any PDF reader.

## How to use it

1. Download or clone this repository.
2. Double-click `index.html` to open it in Chrome, Edge, Firefox or Safari.
3. Click **Open** (or drag a PDF onto the window).
4. Pick a tool and edit.
5. Click **Save**. You get a new file named `yourfile-edited.pdf`. The original isn't changed.

The page loads its PDF and OCR libraries from a CDN, so you need an internet connection the first time you use each feature.

You can also host it for free with GitHub Pages: go to **Settings → Pages**, choose this branch, and open the link it gives you.

### Tools and shortcuts

| Tool | Key | What it does |
|---|---|---|
| Select | <kbd>V</kbd> | Select and copy text. Click an item you added to select it, drag to move it, double-click text to edit it. |
| Text | <kbd>T</kbd> | Click where you want the text and start typing. <kbd>Enter</kbd> starts a new line, <kbd>Esc</kbd> finishes. |
| Highlight | <kbd>H</kbd> | Drag over an area. In Select mode, select some text and press <kbd>H</kbd> to highlight exactly that text. |
| White-out | <kbd>W</kbd> | Drag to cover content with a solid box. White by default, but you can change the color. |
| Draw | <kbd>D</kbd> | Freehand pen. |

- **Color** and **Size** apply to the current tool. If you've selected an item, they change that item.
- <kbd>Delete</kbd> removes the selected item.
- <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes and <kbd>Ctrl</kbd>+<kbd>Y</kbd> redoes.
- <kbd>Ctrl</kbd>+<kbd>S</kbd> saves and <kbd>Ctrl</kbd>+<kbd>O</kbd> opens a file.
- Use **−**, **+** and **Fit** to zoom.

### Making a scanned PDF searchable

Click **Make searchable (OCR)**. The editor finds the pages that have no real text (usually scans or photos) and reads them with [Tesseract](https://github.com/naptha/tesseract.js). It then adds an invisible text layer on top of the image, which is the same method scanners and tools like OCRmyPDF use. The page looks exactly the same, but you can now search, select and copy its words. Click **Save** to keep the searchable version.

The first run downloads the English language data, which is about 10 MB. After that, each page takes a few seconds.

## Limitations

- **White-out is not redaction.** It hides content visually, but the original text is still in the file and can be found with search or copy and paste. Don't use it to remove sensitive information.
- Your edits become part of the page when you save, so reopening the saved file doesn't let you move or edit them again. Keep the original file if you might want to change them later.
- Typed text uses Helvetica, which only covers Latin characters. Other characters are saved as `?`.
- OCR is English only.
- Password-protected or encrypted PDFs can be viewed but not saved. As a workaround, use your browser's **Print → Save as PDF** to make an unprotected copy first.

## How it works

Everything is in three files: `index.html`, `styles.css` and `app.js`.

- [pdf.js](https://mozilla.github.io/pdf.js/) draws the pages and adds a text layer, so your browser's own find and text selection work.
- [pdf-lib](https://pdf-lib.js.org/) writes your edits into the PDF when you save.
- [tesseract.js](https://tesseract.projectnaptha.com/) does the OCR.
