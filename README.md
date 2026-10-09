# PDF Editor

A small PDF editor that runs in your web browser, either as a normal web page or as an app you install on Windows or Mac that works offline. Your files never leave your computer.

It can:

- **Type text** anywhere on a page.
- **Highlight**: drag across text to highlight exactly those letters, or drag a box over pictures and scans.
- **White-out**: cover existing content with a box, then type over it to "edit" what was there.
- **Rectangles**: outlined or filled, in any line thickness.
- **Draw** freehand.
- **Any color** for text, highlights, rectangles and drawing. Pick one of the 16 quick colors, or use **Custom** to choose any color from the full spectrum (or type a hex/RGB value).
- **Convert photos and Word files to PDF**: open iPhone photos (HEIC), JPG, PNG and other images, or Word `.docx` files, and they become PDF pages you can edit, merge and save.
- **Merge**: open several files at once, or use **Add files** to add more to the end. You can mix PDFs, photos and Word files.
- **Page viewer**: a panel showing every page, where you can tick pages to delete or rotate, delete a range (for example pages 3 to 7), rotate pages, or drag them into a new order.
- **Make searchable (OCR)**: reads the words on scanned pages so <kbd>Ctrl</kbd>+<kbd>F</kbd> (<kbd>⌘</kbd>+<kbd>F</kbd> on Mac) can find them, both in the editor and in the saved file in any PDF reader.

## Two versions

| | Browser version | Installable offline app |
|---|---|---|
| Where | `index.html` | the `app/` folder |
| Web address (once GitHub Pages is on) | https://ahkilborn-ui.github.io/PDF-editor/ | https://ahkilborn-ui.github.io/PDF-editor/app/ |
| Internet | Needed. It downloads its PDF, OCR and conversion tools when you use them. | Only for the first visit. After that it works with no connection. |
| Looks like | A browser tab | Its own window, with an icon in the Start menu, taskbar, Dock or Launchpad |
| Opening files | **Open** button, or drag files in | The same, plus **Open with → PDF Editor** from File Explorer or Finder (Chrome and Edge) |
| Space used | Nothing stored | About 19 MB stored by the browser |

Both have exactly the same editing features.

### Turning on GitHub Pages (one time)

Both web addresses work only after this.

1. On GitHub, open this repository and go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Pick the branch that has these files (right now that is `claude/pdf-edit-highlight-search-okg0xt`, the only branch), choose the **/ (root)** folder, and click **Save**.
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
3. Click **Save** (or press <kbd>Ctrl</kbd>+<kbd>S</kbd>). Saving works like Adobe Acrobat:
   - Your changes are saved into the PDF you opened. The first time, Chrome asks **"Allow this site to save changes to *file.pdf*?"**, so click **Allow**.
   - Highlights, text boxes, rectangles, white-out and drawings are saved as standard PDF annotations, the same kind Acrobat's comment tools make. Every PDF reader shows and prints them, and when you reopen the file they're still editable: move them, change them or delete them, here or in Acrobat.
   - **Save As** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) saves a separate copy. Photos and Word files ask where to save the new PDF.
   - A **\*** after the file name in the tab title means there are unsaved changes.
   - Safari and Firefox can't save over a file, so there each save downloads a new copy.

### Tools and shortcuts

| Tool | Key | What it does |
|---|---|---|
| Select | <kbd>V</kbd> | Select and copy text. Click an item you added to select it, drag to move it, double-click text to edit it. |
| Text | <kbd>T</kbd> | Click where you want the text and start typing. <kbd>Enter</kbd> starts a new line, <kbd>Esc</kbd> finishes. |
| Highlight | <kbd>H</kbd> | Drag across text to highlight exactly the letters you drag over, like a highlighter pen. You don't need to hit the letters exactly: when the cursor shows a text I-beam, you're close enough. The highlight follows the line nearest your cursor and stays in the column you're working in. Double-click a word to highlight just that word. Where the cursor is a crosshair, such as over a picture or a scan, dragging highlights a box. |
| White-out | <kbd>W</kbd> | Drag to cover content with a solid box. White by default, but you can change the color. |
| Rectangle | <kbd>R</kbd> | Drag to draw a box. Tick **Fill** for a solid box. **Line** sets the border thickness. |
| Draw | <kbd>D</kbd> | Freehand pen. **Line** sets the thickness. |

- **Colors**, **Text size**, **Line** and **Fill** apply to the current tool. If you've selected an item, they change that item. For example, click a highlight in Select mode and then click a color to recolor it.

### Keyboard shortcuts

On a Mac, use <kbd>⌘</kbd> wherever this says <kbd>Ctrl</kbd>.

| Keys | What it does |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save your changes into the PDF you opened, like Acrobat (Chrome and Edge; other browsers download a copy). Works even while you're typing in a text box. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Save As: save to a different file. |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open files |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Print the edited PDF, not the editor screen |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |
| <kbd>Ctrl</kbd>+<kbd>Y</kbd> or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Redo |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Find words, using the browser's own search |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select all the document's text |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> | Copy, cut and paste text, or the item you selected (a highlight, text box, rectangle or drawing). Pasting text copied from somewhere else adds it as a text box. |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate the selected item |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | Delete the selected item |
| Arrow keys | Move the selected item. Hold <kbd>Shift</kbd> to move it 10 times further. With nothing selected, the arrow keys scroll. |
| <kbd>Enter</kbd> | Edit the selected text box |
| <kbd>Esc</kbd> | Finish typing, clear the selection, close the page viewer, or cancel a popup box |
| <kbd>Page Up</kbd> / <kbd>Page Down</kbd>, <kbd>Space</kbd>, <kbd>Home</kbd> / <kbd>End</kbd> | Scroll through the document |
| <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>−</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> | Zoom in, zoom out, back to 100% |
| <kbd>Ctrl</kbd>+scroll wheel, or pinching on a trackpad | Zoom |
| <kbd>V</kbd> <kbd>T</kbd> <kbd>H</kbd> <kbd>W</kbd> <kbd>R</kbd> <kbd>D</kbd> | Switch to the Select, Text, Highlight, White-out, Rectangle or Draw tool |

The tab title shows a **\*** after the file name when there are unsaved changes.

Saving fixes most problems by itself:

- **The app is busy** (for example reading a scan): the save happens automatically as soon as it finishes.
- **The file is open in another program, like Acrobat:** the app tries again for a few seconds. If the file is still locked, your work is saved to your **Downloads** folder instead, and a popup says so. Close the file in the other program, and the next Ctrl+S saves to it again.
- **The file wasn't fully written:** the app checks every save and rewrites the file if needed.
- **Chrome has forgotten permission to update the file:** it asks you again.
- **A damaged PDF:** the app repairs it. If it can't be repaired, the pages are rebuilt exactly as you see them, as high-quality images with the text still searchable.
- **The PDF tools didn't load** (for example the connection dropped): they're loaded again when you save.

You'll still see a red **Not saved** popup if you close the save window without choosing a place (click **Choose where to save**), or if something goes wrong that the app can't fix (click **Try again**). Closing the tab with unsaved changes asks you to confirm first.

### Merging, deleting and reordering pages

- **Merge**: choose several files in **Open**, or click **Add files** to add more PDFs, photos or Word files to the end. You can also drop files onto the window; if a document is already open, they're added to the end.
- **Page viewer**: click **Page viewer** in the toolbar to open a panel on the right with every page in order. In the panel:
  - **Delete pages**: tick the check box in the top-left corner of each page you want to remove. A **Delete pages** button drops down at the top of the panel. Click it, then **Yes** to confirm, or **No** to keep them. **Clear** unticks everything.
  - **Delete range of pages…**: type the first and last page numbers, for example 3 to 7, then click **Delete pages**. Click **Yes** to delete them, or **No** to go back and change the numbers.
  - **Rotate**: use the **↺** (left) and **↻** (right) buttons in the top-right corner of a page to turn it a quarter turn. To rotate several pages at once, tick them and use the **↺ ↻** buttons next to **Delete pages**. Anything you've added to a page (text, highlights, rectangles, drawings, OCR text) turns with it.
  - **Reorder**: drag a page up or down the list and drop it where you want it.
  - Click a page to jump to it in the main view. Press <kbd>Esc</kbd> or **×** to close the panel.
- While the page viewer is open, the pages move over so the panel never covers them. If a page wouldn't fit, the view zooms out just enough, and goes back to your zoom when you close the panel.
- Above each page in the main view there are also **↑ Up**, **↓ Down** and **Delete page** buttons.
- Every way of deleting pages asks **Are you sure?** first.
- At least one page always has to stay.
- **Undo** reverses page deletions, rotations, moves and added files too.

### Converting photos and Word files

- **Photos**: each photo becomes one page, sized to US Letter (turned sideways for wide photos) with a small margin. iPhone HEIC photos work in any browser, and photos taken sideways are turned the right way up. To turn several photos into one PDF, select them all in **Open**.
- **Word (.docx)**: each page of the document becomes a PDF page, and its words stay searchable with <kbd>Ctrl</kbd>+<kbd>F</kbd>.
- **Google Docs**: in Google Docs, choose **File → Download → PDF Document** (or **Microsoft Word (.docx)**) and open that file here.
- **Old `.doc` files** aren't supported. Open them in Word or Google Docs and save as `.docx` or PDF first.

### Protected PDFs

You can edit and save protected PDFs, for example court or agency documents that block editing or copying.

- **Files that only restrict editing, copying or printing** open normally. When you save, the restrictions are removed so your changes can be saved, and the saved copy has no restrictions.
- **Files that need a password to open** ask for it when you open them. Like Acrobat, saving keeps the same password, and your edits in them stay editable too.
- The unlocking uses [qpdf](https://qpdf.sourceforge.io/), running inside your browser. Your file and password never leave your computer.

### Making a scanned PDF searchable

Click **Make searchable (OCR)**. The editor finds the pages that have no real text (usually scans or photos) and reads them with [Tesseract](https://github.com/naptha/tesseract.js). It then adds an invisible text layer on top of the image, which is the same method scanners and tools like OCRmyPDF use. The page looks exactly the same, but you can now search, select and copy its words. Click **Save** to keep the searchable version.

In the browser version, the first run downloads the English language data (about 3 MB). The offline app already has it. Each page takes a few seconds.

## Limitations

- **White-out is not redaction.** It hides content visually, but the original text is still in the file and can be found with search or copy and paste. Don't use it to remove sensitive information.
- Bookmarks and fillable form fields are kept when you only delete pages or add files to the end. If you reorder the original pages, or put another file's pages before them, the saved PDF is rebuilt from its pages and those are lost.
- Typed text uses Helvetica, which only covers Latin characters. Other characters are saved as `?`.
- OCR is English only.
- Converted Word pages are stored as high-resolution pictures with the real text invisibly on top. That makes them look right and searchable, but the text isn't perfectly sharp when you zoom far in. Fonts that aren't on your computer, such as Calibri on a Mac, are replaced with similar ones, so line breaks can differ slightly from Word. For an exact copy, use **File → Save as PDF** in Word, or **File → Download → PDF** in Google Docs.


## How it works

The editor is five files at the top of the repository:
- `index.html`, `styles.css` and `app.js`: the editor itself
- `convert.js`: converts photos and Word files
- `editable.js`: saves edits as PDF annotations and restores them as editable items when a file is reopened

- [pdf.js](https://mozilla.github.io/pdf.js/) draws the pages and adds a text layer, so your browser's own find and text selection work.
- [pdf-lib](https://pdf-lib.js.org/) writes your edits, merges and page changes into the PDF when you save.
- [tesseract.js](https://tesseract.projectnaptha.com/) does the OCR.
- [heic-to](https://github.com/hoppergee/heic-to) reads iPhone HEIC photos, and [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) with [html2canvas](https://html2canvas.hertzen.com/) lays out and captures Word documents.
- [qpdf](https://qpdf.sourceforge.io/), compiled to run in the browser, unlocks protected PDFs so they can be saved, and adds a password back if you ask it to.

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
