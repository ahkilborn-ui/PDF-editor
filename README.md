# PDF Editor

A small PDF editor that runs in your web browser, either as a normal web page or as an app you install on Windows or Mac that works offline. Your files never leave your computer.

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

## Two versions

| | Browser version | Installable offline app |
|---|---|---|
| Where | `index.html` | the `app/` folder |
| Web address (once GitHub Pages is on) | https://ahkilborn-ui.github.io/PDF-editor/ | https://ahkilborn-ui.github.io/PDF-editor/app/ |
| Internet | Needed. It downloads its PDF, OCR and conversion tools when you use them. | Only for the first visit. After that it works with no connection. |
| Looks like | A browser tab | Its own window, with an icon in the Start menu, taskbar, Dock or Launchpad |
| Opening files | **Open** button, or drag files in | The same, plus **Open with → PDF Editor** from File Explorer or Finder (Chrome and Edge) |
| Space used | Nothing stored | About 18 MB stored by the browser |

Both have exactly the same editing features.

### Turning on GitHub Pages (one time)

Both web addresses work only after this.

1. On GitHub, open this repository and go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Pick the branch that has these files (for example `main`), choose the **/ (root)** folder, and click **Save**.
4. Wait a minute or two, then refresh. The address appears at the top of the page.

### Using the browser version

Open https://ahkilborn-ui.github.io/PDF-editor/ in Chrome, Edge, Firefox or Safari.

You can also use it without GitHub Pages: download this repository as a ZIP, unzip it, and double-click `index.html`. That still needs an internet connection for the PDF tools.

### Installing the offline app

Open https://ahkilborn-ui.github.io/PDF-editor/app/ once while you're online. Wait until the bar at the bottom says **Ready — works offline**, then install it.

**Windows or Mac, with Google Chrome**
- Click **Install app** in the toolbar, or the install icon at the right end of the address bar.
- Or use the **⋮** menu → **Cast, save, and share** → **Install page as app…**
- It then appears in the Start menu or taskbar on Windows, and in Launchpad and the Applications folder on Mac.

**Windows or Mac, with Microsoft Edge**
- Click **Install app** in the toolbar, or use the **⋯** menu → **Apps** → **Install this site as an app**.

**Mac, with Safari (macOS Sonoma 14 or newer)**
- In the menu bar, choose **File → Add to Dock**. The **Install app** button shows these instructions too.

Firefox can't install web apps, but the offline app still works offline in a Firefox tab once you've opened it.

**Updates** happen automatically. When you open the installed app while online, it quietly downloads any new version and uses it from the next time you open it.

**To uninstall**, open the app and use the **⋮** or **⋯** menu at the top of its window → **Uninstall PDF Editor**. In Safari, remove it from the Dock and delete it from the Applications folder.

## How to use it

1. Click **Open** (or drag files onto the window). You can open PDFs, photos or Word `.docx` files. To merge, select several files at once, or click **Add files** afterward.
2. Pick a tool and edit.
3. Click **Save**. You get a new file named `yourfile-edited.pdf`, `yourfile-merged.pdf` if you merged files, or just `yourfile.pdf` if you converted a single photo or Word file without changing it. The file goes to your Downloads folder, and the originals aren't changed.

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

In the browser version, the first run downloads the English language data (about 3 MB). The offline app already has it. Each page takes a few seconds.

## Limitations

- **White-out is not redaction.** It hides content visually, but the original text is still in the file and can be found with search or copy and paste. Don't use it to remove sensitive information.
- Bookmarks and fillable form fields are kept when you only delete pages or add files to the end. If you reorder the original pages, or put another file's pages before them, the saved PDF is rebuilt from its pages and those are lost.
- Your edits become part of the page when you save, so reopening the saved file doesn't let you move or edit them again. Keep the original file if you might want to change them later.
- Typed text uses Helvetica, which only covers Latin characters. Other characters are saved as `?`.
- OCR is English only.
- Converted Word pages are stored as high-resolution pictures with the real text invisibly on top. That makes them look right and searchable, but the text isn't perfectly sharp when you zoom far in. Fonts that aren't on your computer, such as Calibri on a Mac, are replaced with similar ones, so line breaks can differ slightly from Word. For an exact copy, use **File → Save as PDF** in Word, or **File → Download → PDF** in Google Docs.
- Password-protected or encrypted PDFs can be viewed but not saved. As a workaround, use your browser's **Print → Save as PDF** to make an unprotected copy first.

## How it works

The editor is four files at the top of the repository: `index.html`, `styles.css`, `app.js`, and `convert.js` (which converts photos and Word files).

- [pdf.js](https://mozilla.github.io/pdf.js/) draws the pages and adds a text layer, so your browser's own find and text selection work.
- [pdf-lib](https://pdf-lib.js.org/) writes your edits, merges and page changes into the PDF when you save.
- [tesseract.js](https://tesseract.projectnaptha.com/) does the OCR.
- [heic-to](https://github.com/hoppergee/heic-to) reads iPhone HEIC photos, and [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) with [html2canvas](https://html2canvas.hertzen.com/) lays out and captures Word documents.

The browser version loads these libraries from the jsDelivr CDN. The installable app in `app/` is built from the same four files by `tools/build-offline.mjs`. The build copies every library into `app/vendor/` and adds:

- an app manifest (`offline/manifest.webmanifest`), which gives the app its name and icon and makes it installable,
- an install button (`offline/install.js`),
- a service worker (`offline/sw.js`), which stores every file on the device so the app works offline.

### Changing the editor

Edit the files at the top of the repository, then rebuild the offline app so the two versions stay the same:

```
npm install
npm run build
```

Commit the updated `app/` folder along with your change. The build gives the app a new version number whenever any file changes, and installed copies use that to pick up the update.
