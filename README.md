# PDF Editor

A small PDF editor that runs in your web browser. You don't install anything, and your files never leave your computer.

It can:

- **Type text** anywhere on a page.
- **Highlight**: drag a box over an area, or select some text and press <kbd>H</kbd>.
- **White-out**: cover existing content with a box, then type over it to "edit" what was there.
- **Rectangles**: outlined or filled, in any line thickness.
- **Draw** freehand.
- **Any color** for text, highlights, rectangles and drawing. Pick one of the 16 quick colors, or use **Custom** to choose any color from the full spectrum (or type a hex/RGB value).
- **Convert photos and Word files to PDF**: open iPhone photos (HEIC), JPG, PNG and other images, or Word `.docx` files, and they become PDF pages you can edit, merge and save.
- **Merge**: open several files at once, or use **Add files** to add more to the end. You can mix PDFs, photos and Word files.
- **Delete, or move pages** up and down, using the buttons above each page.
- **Make searchable (OCR)**: reads the words on scanned pages so <kbd>Ctrl</kbd>+<kbd>F</kbd> (<kbd>⌘</kbd>+<kbd>F</kbd> on Mac) can find them, both in the editor and in the saved file in any PDF reader.

## How to use it

1. Download or clone this repository.
2. Double-click `index.html` to open it in Chrome, Edge, Firefox or Safari.
3. Click **Open** (or drag files onto the window). You can open PDFs, photos or Word `.docx` files. To merge, select several files at once, or click **Add files** afterward.
4. Pick a tool and edit.
5. Click **Save**. You get a new file named `yourfile-edited.pdf`, `yourfile-merged.pdf` if you merged files, or just `yourfile.pdf` if you converted a single photo or Word file without changing it. The originals aren't changed.

The page loads its PDF and OCR libraries from a CDN, so you need an internet connection the first time you use each feature.

You can also host it for free with GitHub Pages: go to **Settings → Pages**, choose this branch, and open the link it gives you.

### Tools and shortcuts

| Tool | Key | What it does |
|---|---|---|
| Select | <kbd>V</kbd> | Select and copy text. Click an item you added to select it, drag to move it, double-click text to edit it. |
| Text | <kbd>T</kbd> | Click where you want the text and start typing. <kbd>Enter</kbd> starts a new line, <kbd>Esc</kbd> finishes. |
| Highlight | <kbd>H</kbd> | Drag over an area. In Select mode, select some text and press <kbd>H</kbd> to highlight exactly that text. |
| White-out | <kbd>W</kbd> | Drag to cover content with a solid box. White by default, but you can change the color. |
| Rectangle | <kbd>R</kbd> | Drag to draw a box. Tick **Fill** for a solid box. **Line** sets the border thickness. |
| Draw | <kbd>D</kbd> | Freehand pen. **Line** sets the thickness. |

- **Colors**, **Text size**, **Line** and **Fill** apply to the current tool. If you've selected an item, they change that item. For example, click a highlight in Select mode and then click a color to recolor it.
- <kbd>Delete</kbd> removes the selected item.
- <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes and <kbd>Ctrl</kbd>+<kbd>Y</kbd> redoes.
- <kbd>Ctrl</kbd>+<kbd>S</kbd> saves and <kbd>Ctrl</kbd>+<kbd>O</kbd> opens a file.
- Use **−**, **+** and **Fit** to zoom.

### Merging, deleting and reordering pages

- **Merge**: choose several files in **Open**, or click **Add files** to add more PDFs, photos or Word files to the end. You can also drop files onto the window; if a document is already open, they're added to the end.
- Above each page are **↑ Up**, **↓ Down** and **Delete page** buttons.
- **Undo** reverses page deletions, moves and added files too.

### Converting photos and Word files

- **Photos**: each photo becomes one page, sized to US Letter (turned sideways for wide photos) with a small margin. iPhone HEIC photos work in any browser, and photos taken sideways are turned the right way up. To turn several photos into one PDF, select them all in **Open**.
- **Word (.docx)**: each page of the document becomes a PDF page, and its words stay searchable with <kbd>Ctrl</kbd>+<kbd>F</kbd>.
- **Google Docs**: in Google Docs, choose **File → Download → PDF Document** (or **Microsoft Word (.docx)**) and open that file here.
- **Old `.doc` files** aren't supported. Open them in Word or Google Docs and save as `.docx` or PDF first.

### Making a scanned PDF searchable

Click **Make searchable (OCR)**. The editor finds the pages that have no real text (usually scans or photos) and reads them with [Tesseract](https://github.com/naptha/tesseract.js). It then adds an invisible text layer on top of the image, which is the same method scanners and tools like OCRmyPDF use. The page looks exactly the same, but you can now search, select and copy its words. Click **Save** to keep the searchable version.

The first run downloads the English language data, which is about 10 MB. After that, each page takes a few seconds.

## Limitations

- **White-out is not redaction.** It hides content visually, but the original text is still in the file and can be found with search or copy and paste. Don't use it to remove sensitive information.
- Bookmarks and fillable form fields are kept when you only delete pages or add files to the end. If you reorder the original pages, or put another file's pages before them, the saved PDF is rebuilt from its pages and those are lost.
- Your edits become part of the page when you save, so reopening the saved file doesn't let you move or edit them again. Keep the original file if you might want to change them later.
- Typed text uses Helvetica, which only covers Latin characters. Other characters are saved as `?`.
- OCR is English only.
- Converted Word pages are stored as high-resolution pictures with the real text invisibly on top. That makes them look right and searchable, but the text isn't perfectly sharp when you zoom far in. Fonts that aren't on your computer, such as Calibri on a Mac, are replaced with similar ones, so line breaks can differ slightly from Word. For an exact copy, use **File → Save as PDF** in Word, or **File → Download → PDF** in Google Docs.
- Password-protected or encrypted PDFs can be viewed but not saved. As a workaround, use your browser's **Print → Save as PDF** to make an unprotected copy first.

## How it works

Everything is in four files: `index.html`, `styles.css`, `app.js`, and `convert.js` (which handles converting photos and Word files).

- [pdf.js](https://mozilla.github.io/pdf.js/) draws the pages and adds a text layer, so your browser's own find and text selection work.
- [pdf-lib](https://pdf-lib.js.org/) writes your edits, merges and page changes into the PDF when you save.
- [tesseract.js](https://tesseract.projectnaptha.com/) does the OCR.
- [heic-to](https://github.com/hoppergee/heic-to) reads iPhone HEIC photos, and [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) with [html2canvas](https://html2canvas.hertzen.com/) lays out and captures Word documents. These only download when you open such a file.
