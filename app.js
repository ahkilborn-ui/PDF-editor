/* PDF Editor — runs entirely in the browser.
 *
 * pdf.js   renders pages and provides the selectable/searchable text layer.
 * pdf-lib  writes the edits (and merged / deleted / reordered pages) into a new PDF.
 * convert.js turns photos and Word files into PDFs so they can be opened too.
 * tesseract.js  recognizes text in scanned pages (OCR) so Ctrl+F can find it.
 *
 * The open document is a list of pages (state.order) that can come from several
 * source files. Annotations and OCR results are keyed by page id, and stored in
 * "page units": CSS pixels of the page at 100% zoom, measured from the top-left
 * of the page as displayed (rotation applied). They are converted to PDF
 * coordinates only when saving.
 */
(() => {
  'use strict';

  // Libraries come from the jsDelivr CDN in the browser version. The offline
  // app (app/, made by tools/build-offline.mjs) sets PDF_EDITOR_LIB_BASE so
  // the same paths are served from its own vendor/ folder instead.
  const LIB_BASE = window.PDF_EDITOR_LIB_BASE || 'https://cdn.jsdelivr.net/npm/';
  const lib = (path) => new URL(LIB_BASE + path, document.baseURI).href;

  const CDN = {
    pdfjs: lib('pdfjs-dist@4.10.38/build/pdf.min.mjs'),
    pdfjsWorker: lib('pdfjs-dist@4.10.38/build/pdf.worker.min.mjs'),
    pdfjsCmaps: lib('pdfjs-dist@4.10.38/cmaps/'),
    pdfjsFonts: lib('pdfjs-dist@4.10.38/standard_fonts/'),
    tessWorker: lib('tesseract.js@5.1.1/dist/worker.min.js'),
    tessCore: lib('tesseract.js-core@5.1.1'),
    tessLang: lib('@tesseract.js-data/eng@1.0.0/4.0.0_best_int'),
  };

  const FONT_FAMILY = 'Helvetica, Arial, sans-serif';
  const TEXT_LINE_HEIGHT = 1.2;
  const TEXT_PADDING = 2;
  const HIGHLIGHT_OPACITY = 0.4;
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
  const OCR_DPI = 300;
  const OCR_MAX_CANVAS = 5000;
  const MIN_CHARS_FOR_TEXT_PAGE = 20;

  const DEFAULT_COLORS = {
    select: '#000000',
    text: '#000000',
    highlight: '#ffeb3b',
    whiteout: '#ffffff',
    rect: '#1e88e5',
    draw: '#e53935',
  };

  const PALETTE = [
    '#000000', '#5f6368', '#ffffff', '#e53935',
    '#fb8c00', '#ffeb3b', '#c6ff00', '#43a047',
    '#00bfa5', '#00b0ff', '#1e88e5', '#3949ab',
    '#8e24aa', '#ff69b4', '#ffb6c1', '#6d4c41', // hot pink, light pink
  ];

  const state = {
    pdfjs: null,
    sources: [],           // [{ name, bytes, doc }]
    pageById: new Map(),   // id -> page record
    order: [],             // page ids, in document order
    annots: [],
    ocr: {},               // page id -> recognized words
    zoom: 1.25,
    tool: 'select',
    colors: { ...DEFAULT_COLORS },
    fontSize: 14,
    lineWidth: 2,
    rectFill: false,
    selectedId: null,
    editingId: null,
    undo: [],
    redo: [],
    dirty: false,
    changes: 0,            // counts every change, so a save knows if more came in while it ran
    busy: false,
    nextId: 1,
    nextPageId: 1,
    loadToken: 0,
    textReady: Promise.resolve(),
    colorLive: false,
    rotation: {},          // page id -> extra clockwise rotation (0/90/180/270) added in the editor
  };

  const $ = (sel) => document.querySelector(sel);
  const ui = {
    fileInput: $('#file-input'),
    addInput: $('#add-input'),
    saveBtn: $('#save-btn'),
    closeBtn: $('#close-btn'),
    colorInput: $('#color-input'),
    palette: $('#palette'),
    sizeInput: $('#size-input'),
    lineInput: $('#line-input'),
    fillInput: $('#fill-input'),
    undoBtn: $('#undo-btn'),
    redoBtn: $('#redo-btn'),
    deleteBtn: $('#delete-btn'),
    zoomIn: $('#zoom-in'),
    zoomOut: $('#zoom-out'),
    zoomFit: $('#zoom-fit'),
    zoomLabel: $('#zoom-label'),
    ocrBtn: $('#ocr-btn'),
    viewer: $('#viewer'),
    pages: $('#pages'),
    status: $('#status'),
    progress: $('#progress'),
    toolButtons: [...document.querySelectorAll('.tool')],
  };

  // Where the text baseline sits inside a line box, as a fraction of font size.
  // Measured from the real browser font so saved text lines up with the screen.
  const BASELINE_RATIO = (() => {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:100px/${TEXT_LINE_HEIGHT} ${FONT_FAMILY}`;
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline';
    box.append('Hg', marker);
    document.body.append(box);
    const ratio = marker.offsetTop / 100;
    box.remove();
    return ratio > 0.5 && ratio < 1.2 ? ratio : 0.95;
  })();

  // ---------------------------------------------------------------- helpers

  function setStatus(msg) {
    ui.status.textContent = msg;
  }

  function setProgress(value) {
    if (value == null) {
      ui.progress.hidden = true;
    } else {
      ui.progress.hidden = false;
      ui.progress.value = value;
    }
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  function getAnnot(id) {
    return state.annots.find((a) => a.id === id);
  }

  function pages() {
    return state.order.map((id) => state.pageById.get(id));
  }

  function allPages() {
    return [...state.pageById.values()];
  }

  function pageAt(el) {
    const pageEl = el.closest('.page');
    return pageEl ? state.pageById.get(pageEl.dataset.pageId) : null;
  }

  function pointInPage(page, evt) {
    const r = page.el.getBoundingClientRect();
    return { x: (evt.clientX - r.left) / state.zoom, y: (evt.clientY - r.top) / state.zoom };
  }

  const { kindOf, toPdf: convertToPdf, makeSanitizer, writeInvisibleText, unlockPdf, lockPdf, repairPdf, ensurePdfLib } = window.PdfConvert;

  // The tool whose color an annotation type uses.
  function toolFor(type) {
    return type === 'ink' ? 'draw' : type;
  }

  async function loadPdfjs() {
    if (!state.pdfjs) {
      state.pdfjs = await import(CDN.pdfjs);
      state.pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
    }
    return state.pdfjs;
  }

  // ----------------------------------------------------------- undo / redo

  function snapshot() {
    return JSON.stringify({ annots: state.annots, ocr: state.ocr, order: state.order, rotation: state.rotation });
  }

  // Something in the document changed and isn't saved yet.
  function markChanged() {
    state.changes++;
    state.dirty = true;
  }

  function checkpoint() {
    state.undo.push(snapshot());
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
    markChanged();
    updateButtons();
  }

  function restore(snap) {
    const data = JSON.parse(snap);
    state.annots = data.annots;
    state.ocr = data.ocr;
    state.order = data.order;
    state.rotation = data.rotation || {};
    state.selectedId = null;
    state.editingId = null;
    for (const p of allPages()) {
      if (p.vp.rotation !== viewRotation(p)) applyRotation(p);
    }
    layoutPages();
    allPages().forEach((p) => {
      drawAnnots(p);
      drawOcrLayer(p);
    });
    markChanged();
    updateButtons();
  }

  function undo() {
    finishEditing();
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
  }

  function redo() {
    finishEditing();
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
  }

  function updateButtons() {
    const hasDoc = state.order.length > 0;
    document.body.classList.toggle('has-doc', state.pageById.size > 0);
    ui.saveBtn.disabled = !hasDoc || state.busy;
    ui.closeBtn.disabled = !hasDoc || state.busy;
    ui.ocrBtn.disabled = !hasDoc || state.busy;
    ui.undoBtn.disabled = !state.undo.length;
    ui.redoBtn.disabled = !state.redo.length;
    ui.deleteBtn.disabled = state.selectedId == null;
    ui.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    // A dot in the tab title while there are unsaved changes.
    const name = state.saveHandle?.name || state.sources[0]?.name;
    document.title = `${name ? `${name}${state.dirty ? ' *' : ''} — ` : ''}PDF Editor`;
  }

  // -------------------------------------------------------------- loading

  // Open replaces the current document; append (merge) adds pages to the end.
  // Items are Files, or { file, handle } when the browser also gave us a
  // handle to the file on disk (Chrome / Edge) — that's what lets Save write
  // the changes back into the file that was opened.
  // Options: onFile(i, n, name) reports progress; merged: true for a new
  // document combined from several files (Save then asks where to save it).
  // Returns, for each usable file, the index of its source (or null if it
  // couldn't be opened).
  async function openFiles(fileList, append = false, { onFile = null, merged = false } = {}) {
    const entries = [...fileList].map((x) => (x instanceof Blob ? { file: x, handle: null } : x));
    const usable = entries.filter((x) => kindOf(x.file));
    const files = usable.map((x) => x.file);
    const skipped = entries.filter((x) => !kindOf(x.file)).map((x) => x.file);
    if (skipped.length) {
      alert(`These files can't be opened: ${skipped.map((f) => f.name).join(', ')}\n\n` +
        'Supported: PDF, photos (JPG, PNG, iPhone HEIC…) and Word .docx files.');
    }
    if (!files.length) return [];
    if (state.busy) {
      alert('Please wait for the current task to finish.');
      return [];
    }
    append = append && state.order.length > 0;
    if (!append) {
      if (state.dirty && !confirm('You have unsaved changes. Open another file anyway?')) return [];
      resetDocument();
    }
    const token = state.loadToken;
    const before = append ? snapshot() : null;
    let added = 0;
    const results = [];
    state.busy = true;
    state.busyLabel = 'opening files';
    updateButtons();
    try {
      for (const [i, entry] of usable.entries()) {
        onFile?.(i, usable.length, entry.file.name);
        const srcBefore = state.sources.length;
        const n = await addSource(entry.file, token, { password: entry.password });
        if (token !== state.loadToken) return results;
        results.push(state.sources.length > srcBefore ? srcBefore : null);
        added += n;
      }
    } finally {
      state.busy = false;
      updateButtons();
    }
    if (append && added) {
      state.undo.push(before);
      state.redo = [];
      markChanged();
    } else if (files.length > 1) {
      markChanged();
    }
    // Opened a PDF we can write back to: Save updates that file.
    const first = usable[0];
    if (!append && !merged && first?.handle && kindOf(first.file) === 'pdf' && state.sources[0]?.name === first.file.name) {
      state.saveHandle = first.handle;
    }
    const n = state.order.length;
    const mergedNote = state.sources.length > 1 ? ` (merged from ${state.sources.length} files)` : '';
    setStatus(`${n} page${n === 1 ? '' : 's'}${mergedNote}.` +
      (append && added ? ` Added ${added} page${added === 1 ? '' : 's'} at the end.` : '') +
      (state.saveHandle ? ` Ctrl+S saves your changes to ${state.saveHandle.name}.` : ''));
    updateButtons();
    return results;
  }

  const canPickOpenFile = typeof window.showOpenFilePicker === 'function';

  // Open (or add) files. In Chrome and Edge this uses the file picker that
  // keeps a link to the file on disk, so changes can be saved back into it;
  // other browsers use the standard file input.
  async function chooseFiles(append = false) {
    const input = append ? ui.addInput : ui.fileInput;
    if (!canPickOpenFile) {
      input.click();
      return;
    }
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: 'PDFs, photos and Word files',
          accept: {
            'application/pdf': ['.pdf'],
            'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif'],
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
            'application/msword': ['.doc'],
          },
        }],
      });
    } catch (err) {
      if (err.name !== 'AbortError') input.click(); // picker unavailable here: use the standard one
      return;
    }
    const items = await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    openFiles(items, append);
  }

  ui.fileInput.closest('label').addEventListener('click', (e) => {
    if (!canPickOpenFile || e.target === ui.fileInput) return;
    e.preventDefault();
    chooseFiles(false);
  });
  // "Add files" opens the merge window, with the open document listed first.
  ui.addInput.closest('label').addEventListener('click', (e) => {
    if (e.target === ui.addInput) return;
    e.preventDefault();
    openMergeDialog();
  });

  function resetDocument() {
    state.loadToken++;
    for (const s of state.sources) s.doc?.destroy();
    for (const p of allPages()) p.task?.cancel();
    observer.disconnect();
    ui.pages.textContent = '';
    resetPanel();
    Object.assign(state, {
      sources: [], pageById: new Map(), order: [], annots: [], ocr: {}, rotation: {},
      undo: [], redo: [], selectedId: null, editingId: null, dirty: false,
      saveHandle: null,
      textReady: Promise.resolve(),
    });
    updateButtons();
  }

  async function addSource(file, token, { password: knownPassword = null } = {}) {
    try {
      const pdfjs = await loadPdfjs();
      const kind = kindOf(file);
      let bytes;
      let restored = null;
      if (kind === 'pdf') {
        setStatus(`Opening ${file.name}…`);
        bytes = new Uint8Array(await file.arrayBuffer());
        // Edits saved by this editor come back as editable items.
        try {
          restored = await window.PdfEditable.readItems(bytes);
        } catch (err) {
          console.warn('Could not read earlier edits', err);
        }
        if (restored) bytes = restored.bytes;
      } else {
        setStatus(`Converting ${file.name} to PDF…`);
        setProgress(0);
        try {
          bytes = await convertToPdf(file, (f) => setProgress(f));
        } finally {
          setProgress(null);
        }
      }
      const docOptions = {
        isEvalSupported: false,
        // Needed for some Asian-language PDFs and PDFs that don't embed their fonts.
        cMapUrl: CDN.pdfjsCmaps,
        cMapPacked: true,
        standardFontDataUrl: CDN.pdfjsFonts,
      };
      const task = pdfjs.getDocument({ data: bytes.slice(), ...docOptions, ...(knownPassword ? { password: knownPassword } : {}) });
      let password = knownPassword; // remembered so the file can be unlocked when saving
      task.onPassword = (provide, reason) => {
        const again = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
        const pw = prompt(again ? `Wrong password for ${file.name}. Try again:` : `${file.name} is password protected. Password:`);
        if (pw == null) {
          task.destroy();
        } else {
          password = pw;
          provide(pw);
        }
      };
      let doc = await task.promise;
      // A password-protected file saved by this editor: its edits could only
      // be read once the password was known. Unlock a working copy, take the
      // edits out as editable items, and show that copy instead. (Saving puts
      // the same password back.)
      if (kind === 'pdf' && !restored && password) {
        try {
          const found = await window.PdfEditable.readItems(await unlockPdf(bytes, password));
          if (found) {
            const plain = await pdfjs.getDocument({ data: found.bytes.slice(), ...docOptions }).promise;
            doc.destroy();
            doc = plain;
            bytes = found.bytes;
            restored = found;
          }
        } catch (err) {
          console.warn('Could not read earlier edits from the protected file', err);
        }
      }
      if (token !== state.loadToken) {
        doc.destroy();
        return 0;
      }
      const src = state.sources.length;
      state.sources.push({ name: file.name || 'document.pdf', bytes, doc, converted: kind !== 'pdf', password });

      const newPages = [];
      for (let i = 0; i < doc.numPages; i++) {
        const pdfPage = await doc.getPage(i + 1);
        if (token !== state.loadToken) return 0;
        const page = createPage(src, i, pdfPage);
        state.order.push(page.id);
        newPages.push(page);
      }
      if (restored) restoreItems(restored.items, newPages);
      layoutPages();
      // Build text layers for every page so the browser's Ctrl+F covers the whole document.
      const prev = state.textReady;
      state.textReady = (async () => {
        await prev;
        for (const page of newPages) {
          if (token !== state.loadToken) return;
          await renderTextLayer(page);
        }
      })();
      return doc.numPages;
    } catch (err) {
      console.error(err);
      setStatus(`Could not open ${file.name}: ${err.message || err}`);
      alert(`Could not open ${file.name}: ${err.message || err}.`);
      return 0;
    }
  }

  // Put back edits saved earlier by this editor (see editable.js) as normal,
  // editable items. If the page has been rotated since (e.g. in another
  // program), the items are turned to match.
  function restoreItems(found, newPages) {
    for (const { index, rot, item } of found) {
      const page = newPages[index];
      if (!page) continue;
      const a = { ...item, id: state.nextId++, page: page.id };
      const quarters = ((((page.vp.rotation - rot) / 90) % 4) + 4) % 4;
      if (quarters) {
        const saved = page.pdfPage.getViewport({ scale: 1, rotation: rot });
        turnItem(a, saved.width, saved.height, quarters);
      }
      state.annots.push(a);
    }
    for (const page of newPages) drawAnnots(page);
  }

  function createPage(src, srcIndex, pdfPage) {
    const id = `p${state.nextPageId++}`;
    const vp = pdfPage.getViewport({ scale: 1 });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const bar = document.createElement('div');
    bar.className = 'page-bar';
    const label = document.createElement('span');
    label.className = 'page-label';
    const srcName = document.createElement('span');
    srcName.className = 'page-src';
    srcName.textContent = state.sources[src].name;
    const actions = document.createElement('span');
    actions.className = 'page-actions';
    actions.innerHTML =
      '<button class="btn small" data-act="up" title="Move this page up">↑ Up</button>' +
      '<button class="btn small" data-act="down" title="Move this page down">↓ Down</button>' +
      '<button class="btn small danger" data-act="delete" title="Delete this page">Delete page</button>';
    bar.append(label, srcName, actions);

    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.pageId = id;
    const canvas = document.createElement('canvas');
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const ocrLayer = document.createElement('div');
    ocrLayer.className = 'ocrLayer';
    const annotLayer = document.createElement('div');
    annotLayer.className = 'annotLayer';
    el.append(canvas, textLayer, ocrLayer, annotLayer);
    wrap.append(bar, el);
    wrap.dataset.pageId = id;

    const page = {
      id, src, srcIndex, pdfPage, vp, wrap, el, label, canvas, textLayer, ocrLayer, annotLayer,
      renderedZoom: 0, task: null, charCount: undefined,
    };
    state.pageById.set(id, page);
    sizePage(page);
    attachPageEvents(page);
    observer.observe(el);
    return page;
  }

  // Put page elements in document order and refresh their labels.
  function layoutPages() {
    const list = pages();
    const keep = new Set(state.order);
    for (const wrap of [...ui.pages.children]) {
      if (!keep.has(wrap.dataset.pageId)) wrap.remove();
    }
    list.forEach((page, i) => {
      if (ui.pages.children[i] !== page.wrap) ui.pages.insertBefore(page.wrap, ui.pages.children[i] || null);
      page.label.textContent = `Page ${i + 1} of ${list.length}`;
      page.wrap.querySelector('[data-act="up"]').disabled = i === 0;
      page.wrap.querySelector('[data-act="down"]').disabled = i === list.length - 1;
      page.wrap.querySelector('[data-act="delete"]').disabled = list.length === 1;
    });
    document.body.classList.toggle('multi-source', state.sources.length > 1);
    if (state.selectedId != null && !keep.has(getAnnot(state.selectedId)?.page)) select(null);
    renderPanel();
  }

  function sizePage(page) {
    page.el.style.width = `${page.vp.width * state.zoom}px`;
    page.el.style.height = `${page.vp.height * state.zoom}px`;
    page.el.style.setProperty('--scale-factor', state.zoom);
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) renderCanvas(state.pageById.get(entry.target.dataset.pageId));
    }
  }, { root: ui.viewer, rootMargin: '600px 0px' });

  async function renderCanvas(page) {
    if (!page || page.renderedZoom === state.zoom) return;
    const zoom = state.zoom;
    page.renderedZoom = zoom;
    if (page.task) page.task.cancel();
    const dpr = window.devicePixelRatio || 1;
    const viewport = viewportOf(page, zoom * dpr);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    page.task = page.pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport });
    try {
      await page.task.promise;
      page.canvas.replaceWith(canvas);
      page.canvas = canvas;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.error(err);
      if (page.renderedZoom === zoom) page.renderedZoom = 0;
    } finally {
      page.task = null;
    }
  }

  async function renderTextLayer(page) {
    try {
      const content = await page.pdfPage.getTextContent();
      page.charCount = content.items.reduce((n, it) => n + (it.str ? it.str.replace(/\s/g, '').length : 0), 0);
      const layer = new state.pdfjs.TextLayer({
        textContentSource: content,
        container: page.textLayer,
        viewport: page.vp,
      });
      await layer.render();
      page.textIndex = null;
      if (!page.textLayer.dataset.listening) {
        page.textLayer.dataset.listening = '1';
        page.textLayer.addEventListener('mousedown', () => page.textLayer.classList.add('selecting'));
      }
    } catch (err) {
      console.error('Text layer failed for page', page.id, err);
      page.charCount = page.charCount || 0;
    }
  }

  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.textLayer.selecting').forEach((el) => el.classList.remove('selecting'));
  });

  // ---------------------------------------------------------- page actions

  function movePage(id, dir) {
    const i = state.order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.order.length) return;
    finishEditing();
    checkpoint();
    const order = [...state.order];
    [order[i], order[j]] = [order[j], order[i]];
    state.order = order;
    layoutPages();
    state.pageById.get(id).wrap.scrollIntoView({ block: 'nearest' });
    setStatus(`Moved page to position ${j + 1}.`);
  }

  // The "Delete page" button above a page in the main view. Like every page
  // deletion, it asks first.
  async function deletePage(id) {
    if (state.order.length <= 1) return;
    const pos = state.order.indexOf(id) + 1;
    if (await askConfirm(`Delete page ${pos}? You can bring it back with Undo.`)) deletePages([id]);
  }

  // Delete several pages as one undoable step. At least one page must stay.
  function deletePages(ids) {
    const remove = new Set(ids.filter((id) => state.order.includes(id)));
    if (!remove.size || remove.size >= state.order.length) return false;
    finishEditing();
    const positions = state.order.map((id, i) => (remove.has(id) ? i + 1 : 0)).filter(Boolean);
    checkpoint();
    state.order = state.order.filter((id) => !remove.has(id));
    for (const id of remove) panel.checked.delete(id);
    layoutPages();
    const what = positions.length === 1 ? `page ${positions[0]}` : `${positions.length} pages`;
    setStatus(`Deleted ${what}. Press Ctrl+Z (Undo) to bring ${positions.length === 1 ? 'it' : 'them'} back.`);
    return true;
  }

  // Move a page so it sits just before another page (or at the end when beforeId is null).
  function movePageBefore(id, beforeId) {
    const order = state.order.filter((x) => x !== id);
    const at = beforeId == null ? order.length : order.indexOf(beforeId);
    if (at < 0) return;
    order.splice(at, 0, id);
    if (order.every((x, i) => x === state.order[i])) return;
    finishEditing();
    checkpoint();
    state.order = order;
    layoutPages();
    setStatus(`Moved page to position ${at + 1}.`);
  }

  ui.pages.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-bar button');
    if (!btn) return;
    const id = btn.closest('.page-wrap').dataset.pageId;
    if (btn.dataset.act === 'up') movePage(id, -1);
    else if (btn.dataset.act === 'down') movePage(id, 1);
    else if (btn.dataset.act === 'delete') deletePage(id);
  });

  // --------------------------------------------------------- page rotation
  //
  // Pages can be turned in 90° steps. The extra turn is kept per page in
  // state.rotation (so it's undoable) and saved as the page's /Rotate value.
  // Things added to the page are turned with it.

  // The rotation a page is shown at: its own rotation plus any turn added here.
  function viewRotation(page) {
    return (page.pdfPage.rotate + (state.rotation[page.id] || 0)) % 360;
  }

  function viewportOf(page, scale) {
    return page.pdfPage.getViewport({ scale, rotation: viewRotation(page) });
  }

  // Re-lay out a page after its rotation changed (or was undone).
  function applyRotation(page) {
    page.vp = viewportOf(page, 1);
    sizePage(page);
    page.renderedZoom = 0;
    // Redraw now if it's on screen; otherwise the scroll observer will when it comes into view.
    if (nearView(page)) renderCanvas(page);
    page.textLayer.textContent = '';
    page.textLayer.removeAttribute('style');
    renderTextLayer(page);
    drawAnnots(page);
    drawOcrLayer(page);
    const thumb = panel.items.get(page.id);
    if (thumb) {
      thumb.rendered = false;
      thumb.stale = true; // redrawn the next time the page viewer shows it
      if (panel.open) renderThumb(page.id);
      scheduleThumbOverlay(page.id);
    }
  }

  function nearView(page) {
    const r = page.el.getBoundingClientRect();
    const vr = ui.viewer.getBoundingClientRect();
    return r.bottom > vr.top - 600 && r.top < vr.bottom + 600 && r.width > 0;
  }

  // Where a point on a W×H page ends up after turning it clockwise `quarters` times.
  function turnPoint(x, y, W, H, quarters) {
    for (let i = 0; i < quarters; i++) {
      [x, y] = [H - y, x];
      [W, H] = [H, W];
    }
    return [round(x), round(y)];
  }

  // Turn everything added to a page along with the page.
  // Turn one item on a W×H page clockwise `quarters` times.
  function turnItem(a, W, H, quarters) {
    if (a.type === 'ink') {
      a.points = a.points.map(([x, y]) => turnPoint(x, y, W, H, quarters));
    } else if (a.type === 'text') {
      [a.x, a.y] = turnPoint(a.x, a.y, W, H, quarters);
      a.rot = ((a.rot || 0) + quarters * 90) % 360;
    } else {
      const [x1, y1] = turnPoint(a.x, a.y, W, H, quarters);
      const [x2, y2] = turnPoint(a.x + a.w, a.y + a.h, W, H, quarters);
      Object.assign(a, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
    }
  }

  function turnPageContent(page, quarters) {
    const W = page.vp.width;
    const H = page.vp.height;
    const deg = quarters * 90;
    for (const a of state.annots) {
      if (a.page === page.id) turnItem(a, W, H, quarters);
    }
    for (const w of state.ocr[page.id] || []) {
      [w.x, w.baseline] = turnPoint(w.x, w.baseline, W, H, quarters);
      w.rot = ((w.rot || 0) + deg) % 360;
    }
  }

  // Rotate pages by +90 (clockwise) or -90 (counterclockwise), as one undo step.
  function rotatePages(ids, degrees) {
    const list = ids.map((id) => state.pageById.get(id)).filter((p) => p && state.order.includes(p.id));
    if (!list.length) return;
    finishEditing();
    checkpoint();
    const quarters = (((degrees / 90) % 4) + 4) % 4;
    for (const page of list) {
      turnPageContent(page, quarters);
      state.rotation[page.id] = ((state.rotation[page.id] || 0) + quarters * 90) % 360;
      applyRotation(page);
    }
    if (state.selectedId != null) select(null);
    const which = list.length === 1 ? `page ${state.order.indexOf(list[0].id) + 1}` : `${list.length} pages`;
    setStatus(`Rotated ${which} ${degrees > 0 ? 'clockwise' : 'counterclockwise'}.`);
  }

  // ----------------------------------------------------------- page viewer
  //
  // A panel on the right listing every page. Tick pages to delete them (a
  // "Delete pages" button drops down), drag pages to reorder them, or delete
  // a numbered range. Deletions are confirmed first and can be undone.

  // Width of the page pictures, adjustable with the − / + buttons in the
  // panel (remembered on this computer). The largest fills the panel.
  const THUMB_SIZES = [110, 140, 175, 212];
  let THUMB_WIDTH = (() => {
    try {
      const saved = Number(localStorage.getItem('pdfEditor.thumbWidth'));
      return THUMB_SIZES.includes(saved) ? saved : 140;
    } catch {
      return 140;
    }
  })();

  const panel = {
    el: $('#page-panel'),
    list: $('#panel-list'),
    count: $('#panel-count'),
    toggleBtn: $('#pages-btn'),
    selection: $('#panel-selection'),
    deleteBtn: $('#panel-delete-btn'),
    clearBtn: $('#panel-clear-btn'),
    rangeBtn: $('#panel-range-btn'),
    open: false,
    checked: new Set(),   // page ids ticked for deletion
    items: new Map(),     // page id -> { item, frame, canvas, checkbox, num, rendered }
    dragId: null,
    dropBefore: undefined,
  };

  const thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) renderThumb(entry.target.dataset.pageId);
    }
  }, { root: panel.list, rootMargin: '400px 0px' });

  function togglePanel(open = !panel.open) {
    if (open === panel.open) return;
    panel.open = open;
    panel.el.classList.toggle('open', open);
    panel.el.inert = !open;
    panel.toggleBtn.classList.toggle('active', open);
    panel.toggleBtn.setAttribute('aria-expanded', String(open));
    // On wider screens the pages move over to make room for the panel
    // (CSS), and zoom out if needed so whole pages stay visible.
    document.body.classList.toggle('panel-open', open);
    fitPagesBesidePanel(open);
    if (open) renderPanel();
  }

  // The panel sits beside the pages (rather than over them) unless the
  // window is too narrow; see .panel-open in styles.css.
  const panelBeside = window.matchMedia('(min-width: 521px)');

  function fitPagesBesidePanel(open) {
    if (!state.order.length || !panelBeside.matches) return;
    const scrollbar = ui.viewer.offsetWidth - ui.viewer.clientWidth;
    const room = ui.viewer.parentElement.clientWidth - scrollbar - (open ? panel.el.offsetWidth : 0) - 48;
    const widest = Math.max(...pages().map((p) => p.vp.width));
    if (open) {
      panel.zoomBefore = null;
      if (widest * state.zoom > room) {
        panel.zoomBefore = state.zoom;
        setZoom(room / widest);
        panel.zoomSet = state.zoom;
      }
    } else if (panel.zoomBefore != null) {
      // Go back to the earlier zoom, unless it was changed while the panel was open.
      if (Math.abs(state.zoom - panel.zoomSet) < 1e-3) setZoom(panel.zoomBefore);
      panel.zoomBefore = null;
    }
  }

  function resetPanel() {
    thumbObserver.disconnect();
    panel.items.clear();
    panel.checked.clear();
    panel.list.textContent = '';
    renderPanel();
  }

  function panelItem(page) {
    let entry = panel.items.get(page.id);
    if (entry) return entry;
    const item = document.createElement('div');
    item.className = 'thumb';
    item.draggable = true;
    item.dataset.pageId = page.id;
    const frame = document.createElement('div');
    frame.className = 'thumb-frame';
    const canvas = document.createElement('canvas');
    const check = document.createElement('label');
    check.className = 'thumb-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    check.append(checkbox);
    const turns = document.createElement('div');
    turns.className = 'thumb-rotate';
    turns.innerHTML =
      '<button type="button" data-turn="-90" title="Rotate left (counterclockwise)" aria-label="Rotate page left">↺</button>' +
      '<button type="button" data-turn="90" title="Rotate right (clockwise)" aria-label="Rotate page right">↻</button>';
    turns.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-turn]');
      if (btn) rotatePages([page.id], Number(btn.dataset.turn));
    });
    // Edits (highlights, text, shapes, drawings) drawn over the page picture.
    const overlay = document.createElement('canvas');
    overlay.className = 'thumb-overlay';
    frame.append(canvas, overlay, check, turns);
    const num = document.createElement('div');
    num.className = 'thumb-num';
    frame.append(num); // page number on the picture's bottom edge (saves space)
    item.append(frame);
    entry = { item, frame, canvas, overlay, checkbox, num, rendered: false };
    sizeThumb(entry, page);
    panel.items.set(page.id, entry);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) panel.checked.add(page.id);
      else panel.checked.delete(page.id);
      item.classList.toggle('checked', checkbox.checked);
      updatePanelSelection();
    });
    // Clicking a page (not its check box) shows it in the main view.
    frame.addEventListener('click', (e) => {
      if (e.target.closest('.thumb-check, .thumb-rotate')) return;
      page.wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    item.addEventListener('dragstart', (e) => {
      panel.dragId = page.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', page.id);
      requestAnimationFrame(() => item.classList.add('dragging'));
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      clearDropMarker();
      panel.dragId = null;
    });
    thumbObserver.observe(item);
    return entry;
  }

  function sizeThumb(entry, page) {
    entry.canvas.style.width = `${THUMB_WIDTH}px`;
    entry.canvas.style.height = `${Math.round(page.vp.height * (THUMB_WIDTH / page.vp.width))}px`;
  }

  // − / + : smaller or larger page pictures.
  function setThumbSize(step) {
    const i = THUMB_SIZES.indexOf(THUMB_WIDTH);
    const next = THUMB_SIZES[Math.min(THUMB_SIZES.length - 1, Math.max(0, i + step))];
    if (next === THUMB_WIDTH) return;
    THUMB_WIDTH = next;
    try {
      localStorage.setItem('pdfEditor.thumbWidth', String(next));
    } catch {
      // not remembered (e.g. private window): fine
    }
    for (const [id, entry] of panel.items) {
      const page = state.pageById.get(id);
      if (!page) continue;
      sizeThumb(entry, page);
      drawThumbOverlay(id);
      // Re-render pictures as they come into view, at the new size.
      entry.rendered = false;
      thumbObserver.unobserve(entry.item);
      thumbObserver.observe(entry.item);
    }
    updateThumbSizeButtons();
  }

  function updateThumbSizeButtons() {
    $('#thumb-smaller').disabled = THUMB_WIDTH === THUMB_SIZES[0];
    $('#thumb-larger').disabled = THUMB_WIDTH === THUMB_SIZES[THUMB_SIZES.length - 1];
  }

  async function renderThumb(id) {
    const entry = panel.items.get(id);
    const page = state.pageById.get(id);
    if (!entry || !page || entry.rendered) return;
    entry.rendered = true;
    entry.stale = false;
    const dpr = window.devicePixelRatio || 1;
    const viewport = viewportOf(page, (THUMB_WIDTH / page.vp.width) * dpr);
    entry.canvas.style.height = `${Math.round(page.vp.height * (THUMB_WIDTH / page.vp.width))}px`;
    entry.canvas.width = Math.floor(viewport.width);
    entry.canvas.height = Math.floor(viewport.height);
    try {
      await page.pdfPage.render({ canvasContext: entry.canvas.getContext('2d'), viewport }).promise;
    } catch (err) {
      console.error('Thumbnail failed for page', id, err);
      entry.rendered = false;
    }
  }

  // Show the pages in document order with their current numbers.
  function renderPanel() {
    const list = pages();
    for (const id of panel.checked) if (!state.order.includes(id)) panel.checked.delete(id);
    panel.count.textContent = list.length ? `(${list.length})` : '';
    panel.rangeBtn.disabled = list.length < 2;
    if (!panel.open) {
      updatePanelSelection();
      return;
    }
    if (!list.length) {
      panel.list.innerHTML = '<p class="panel-empty">Open a file to see its pages here.</p>';
    } else {
      panel.list.querySelector('.panel-empty')?.remove();
      const keep = new Set(state.order);
      for (const el of [...panel.list.children]) if (!keep.has(el.dataset.pageId)) el.remove();
      list.forEach((page, i) => {
        const entry = panelItem(page);
        if (panel.list.children[i] !== entry.item) panel.list.insertBefore(entry.item, panel.list.children[i] || null);
        entry.num.textContent = `Page ${i + 1}`;
        const checked = panel.checked.has(page.id);
        entry.checkbox.checked = checked;
        entry.checkbox.setAttribute('aria-label', `Select page ${i + 1}`);
        entry.item.classList.toggle('checked', checked);
        if (entry.stale) renderThumb(page.id);
        drawThumbOverlay(page.id);
      });
    }
    updatePanelSelection();
  }

  function updatePanelSelection() {
    const n = panel.checked.size;
    panel.selection.classList.toggle('show', n > 0);
    panel.deleteBtn.textContent = n === 1 ? 'Delete 1 page' : `Delete ${n} pages`;
    for (const btn of panel.selection.querySelectorAll('button')) btn.tabIndex = n > 0 ? 0 : -1;
  }

  // --- edits shown on the page pictures

  const thumbOverlayQueue = new Set();
  let thumbOverlayFrame = 0;

  // Redraw a page picture's edits soon (at most once per screen refresh).
  function scheduleThumbOverlay(pageId) {
    if (!panel.open || !panel.items.has(pageId)) return;
    thumbOverlayQueue.add(pageId);
    if (thumbOverlayFrame) return;
    thumbOverlayFrame = requestAnimationFrame(() => {
      thumbOverlayFrame = 0;
      for (const id of thumbOverlayQueue) drawThumbOverlay(id);
      thumbOverlayQueue.clear();
    });
  }

  function drawThumbOverlay(id) {
    const entry = panel.items.get(id);
    const page = state.pageById.get(id);
    if (!entry || !page) return;
    const dpr = window.devicePixelRatio || 1;
    const shown = THUMB_WIDTH / page.vp.width;
    const c = entry.overlay;
    c.width = Math.round(page.vp.width * shown * dpr);
    c.height = Math.round(page.vp.height * shown * dpr);
    c.style.width = `${THUMB_WIDTH}px`;
    c.style.height = `${Math.round(page.vp.height * shown)}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(shown * dpr, 0, 0, shown * dpr, 0, 0);
    for (const a of state.annots) {
      if (a.page === id) paintItem(ctx, a);
    }
  }

  // Draw one edit with canvas drawing calls, in page units (as on screen).
  function paintItem(ctx, a) {
    ctx.save();
    if (a.type === 'highlight') {
      ctx.globalAlpha = HIGHLIGHT_OPACITY;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
    } else if (a.type === 'whiteout') {
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
    } else if (a.type === 'rect') {
      const half = Math.min(a.width / 2, a.w / 2, a.h / 2);
      if (a.fill) {
        ctx.fillStyle = a.color;
        ctx.fillRect(a.x, a.y, a.w, a.h);
      }
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.strokeRect(a.x + half, a.y + half, a.w - 2 * half, a.h - 2 * half);
    } else if (a.type === 'ink') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (a.points.length === 1) ctx.lineTo(a.points[0][0] + 0.01, a.points[0][1]);
      ctx.stroke();
    } else if (a.type === 'text') {
      ctx.translate(a.x, a.y);
      if (a.rot) ctx.rotate((a.rot * Math.PI) / 180);
      ctx.fillStyle = a.color;
      ctx.font = `${a.size}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'alphabetic';
      textLines(a, (s) => ctx.measureText(s).width).forEach((line, k) => {
        ctx.fillText(line, TEXT_PADDING, TEXT_PADDING + a.size * TEXT_LINE_HEIGHT * k + a.size * BASELINE_RATIO);
      });
    }
    ctx.restore();
  }

  // Page numbers (1-based, current order) as short text, e.g. "2, 5 and 7".
  function describePages(ids) {
    const nums = ids.map((id) => state.order.indexOf(id) + 1).sort((a, b) => a - b);
    if (nums.length === 1) return `page ${nums[0]}`;
    if (nums.length <= 6) return `pages ${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`;
    return `${nums.length} pages`;
  }

  // --- reordering by drag and drop

  function clearDropMarker() {
    panel.list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    panel.dropBefore = undefined;
  }

  panel.list.addEventListener('dragover', (e) => {
    if (!panel.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const items = [...panel.list.querySelectorAll('.thumb')];
    if (!items.length) return;
    // Land before the first page whose middle is below the pointer.
    let target = items.find((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    clearDropMarker();
    if (target) {
      target.classList.add('drop-before');
      panel.dropBefore = target.dataset.pageId;
    } else {
      target = items[items.length - 1];
      target.classList.add('drop-after');
      panel.dropBefore = null;
    }
  });
  panel.list.addEventListener('dragleave', (e) => {
    if (!panel.list.contains(e.relatedTarget)) clearDropMarker();
  });
  panel.list.addEventListener('drop', (e) => {
    if (!panel.dragId) return;
    e.preventDefault();
    const before = panel.dropBefore;
    const id = panel.dragId;
    clearDropMarker();
    if (before !== undefined && before !== id) movePageBefore(id, before);
  });

  // --- confirmation and range dialogs

  const confirmUi = {
    dialog: $('#confirm-dialog'),
    title: $('#confirm-title'),
    message: $('#confirm-message'),
    yes: $('#confirm-yes'),
    no: $('#confirm-no'),
  };

  // Ask a yes/no question. Resolves true for Yes, false for No or Esc.
  // Ask a question with two buttons; by default "Are you sure?" with Yes / No.
  function askConfirm(message, { title = 'Are you sure?', yes = 'Yes', no = 'No', danger = true, warning = false } = {}) {
    return new Promise((resolve) => {
      confirmUi.dialog.classList.toggle('warning', warning);
      confirmUi.title.textContent = title;
      confirmUi.message.textContent = message;
      confirmUi.yes.hidden = !yes; // a warning may have only "OK"
      confirmUi.yes.textContent = yes || '';
      confirmUi.no.textContent = no;
      confirmUi.yes.classList.toggle('danger-solid', danger);
      confirmUi.yes.classList.toggle('primary', !danger);
      const finish = (answer) => {
        confirmUi.yes.onclick = confirmUi.no.onclick = confirmUi.dialog.oncancel = null;
        confirmUi.dialog.close();
        resolve(answer);
      };
      confirmUi.yes.onclick = () => finish(true);
      confirmUi.no.onclick = () => finish(false);
      confirmUi.dialog.oncancel = (e) => {
        e.preventDefault();
        finish(false);
      };
      confirmUi.dialog.showModal();
      confirmUi.no.focus();
    });
  }

  async function deleteChecked() {
    const ids = state.order.filter((id) => panel.checked.has(id));
    if (!ids.length) return;
    if (ids.length >= state.order.length) {
      alert('You can\'t delete every page. Untick at least one page to keep.');
      return;
    }
    const sure = await askConfirm(`Delete ${describePages(ids)}? You can bring ${ids.length === 1 ? 'it' : 'them'} back with Undo.`);
    if (sure) deletePages(ids);
  }

  const rangeUi = {
    dialog: $('#range-dialog'),
    form: $('#range-form'),
    from: $('#range-from'),
    to: $('#range-to'),
    total: $('#range-total'),
    error: $('#range-error'),
    cancel: $('#range-cancel'),
  };

  function openRangeDialog(keepValues = false) {
    const n = state.order.length;
    if (n < 2) return;
    rangeUi.from.max = rangeUi.to.max = n;
    if (!keepValues) {
      rangeUi.from.value = '';
      rangeUi.to.value = '';
    }
    rangeUi.total.textContent = `This document has ${n} pages.`;
    rangeUi.error.textContent = '';
    rangeUi.dialog.showModal();
    rangeUi.from.focus();
    rangeUi.from.select();
  }

  rangeUi.cancel.addEventListener('click', () => rangeUi.dialog.close());
  for (const input of [rangeUi.from, rangeUi.to]) {
    input.addEventListener('input', () => { rangeUi.error.textContent = ''; });
  }
  rangeUi.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = state.order.length;
    const from = Number(rangeUi.from.value);
    const to = Number(rangeUi.to.value);
    let problem = '';
    if (!rangeUi.from.value || !rangeUi.to.value) problem = 'Enter both page numbers.';
    else if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > n || to > n) problem = `Page numbers must be between 1 and ${n}.`;
    else if (from > to) problem = 'The first page number can\'t be bigger than the second.';
    else if (to - from + 1 >= n) problem = 'That\'s every page. At least one page has to stay.';
    if (problem) {
      rangeUi.error.textContent = problem;
      return;
    }
    rangeUi.dialog.close();
    const count = to - from + 1;
    const what = from === to ? `page ${from}` : `pages ${from} to ${to} (${count} pages)`;
    const sure = await askConfirm(`Delete ${what}? You can bring ${count === 1 ? 'it' : 'them'} back with Undo.`);
    if (sure) deletePages(state.order.slice(from - 1, to));
    else openRangeDialog(true); // "No" goes back to the range so it can be changed
  });

  panel.toggleBtn.addEventListener('click', () => togglePanel());
  $('#thumb-smaller').addEventListener('click', () => setThumbSize(-1));
  $('#thumb-larger').addEventListener('click', () => setThumbSize(1));
  updateThumbSizeButtons();
  $('#panel-close').addEventListener('click', () => togglePanel(false));
  panel.deleteBtn.addEventListener('click', deleteChecked);
  for (const btn of panel.selection.querySelectorAll('[data-turn]')) {
    btn.addEventListener('click', () => rotatePages(state.order.filter((id) => panel.checked.has(id)), Number(btn.dataset.turn)));
  }
  panel.clearBtn.addEventListener('click', () => {
    panel.checked.clear();
    renderPanel();
  });
  panel.rangeBtn.addEventListener('click', () => openRangeDialog());

  // ----------------------------------------------------------------- zoom

  function setZoom(zoom) {
    if (!state.order.length) return;
    zoom = Math.min(5, Math.max(0.25, zoom));
    if (Math.abs(zoom - state.zoom) < 1e-3) return;
    finishEditing();
    // Keep the same spot in the document in view.
    const v = ui.viewer;
    const relY = (v.scrollTop + v.clientHeight / 2) / v.scrollHeight;
    state.zoom = zoom;
    for (const page of allPages()) {
      sizePage(page);
      drawAnnots(page);
      drawOcrLayer(page);
    }
    v.scrollTop = relY * v.scrollHeight - v.clientHeight / 2;
    for (const page of pages()) {
      if (nearView(page)) renderCanvas(page);
    }
    updateButtons();
  }

  function zoomStep(dir) {
    const z = state.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 1e-3) : [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-3);
    if (next) setZoom(next);
  }

  function zoomFit() {
    if (!state.order.length) return;
    const widest = Math.max(...pages().map((p) => p.vp.width));
    setZoom((ui.viewer.clientWidth - 48) / widest);
  }

  // ------------------------------------------------------- annotation view

  function drawAnnots(page) {
    const layer = page.annotLayer;
    layer.textContent = '';
    for (const a of state.annots) {
      if (a.page === page.id) layer.append(createAnnotEl(a));
    }
    scheduleThumbOverlay(page.id);
    updateSelectionUi();
  }

  function redrawPageOf(annot) {
    const page = state.pageById.get(annot.page);
    if (page) drawAnnots(page);
  }

  function createAnnotEl(a) {
    const z = state.zoom;
    let el;
    if (a.type === 'ink') {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const xs = a.points.map((p) => p[0]);
      const ys = a.points.map((p) => p[1]);
      const pad = a.width;
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      const w = Math.max(...xs) + pad - minX;
      const h = Math.max(...ys) + pad - minY;
      el.setAttribute('class', 'annot ink');
      el.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
      Object.assign(el.style, { left: `${minX * z}px`, top: `${minY * z}px`, width: `${w * z}px`, height: `${h * z}px` });
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      path.setAttribute('points', a.points.map((p) => p.join(',')).join(' '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', a.color);
      path.setAttribute('stroke-width', a.width);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      el.append(path);
    } else {
      el = document.createElement('div');
      el.style.left = `${a.x * z}px`;
      el.style.top = `${a.y * z}px`;
      if (a.type === 'text') {
        el.className = 'annot txt';
        el.textContent = a.text;
        el.style.fontSize = `${a.size * z}px`;
        el.style.color = a.color;
        if (a.w) {
          // Sized by dragging its handles: the text wraps inside the box.
          el.classList.add('boxed');
          el.style.width = `${a.w * z}px`;
          el.style.minHeight = `${a.h * z}px`;
        }
        // Text on a page that was rotated after typing turns with the page.
        if (a.rot) el.style.transform = `rotate(${a.rot}deg)`;
      } else {
        el.style.width = `${a.w * z}px`;
        el.style.height = `${a.h * z}px`;
        if (a.type === 'rect') {
          el.className = 'annot rect';
          el.style.border = `${a.width * z}px solid ${a.color}`;
          el.style.background = a.fill ? a.color : 'transparent';
        } else {
          el.className = `annot ${a.type === 'highlight' ? 'hl' : 'wo'}`;
          el.style.background = a.color;
        }
      }
    }
    el.dataset.id = a.id;
    if (selectedItems().includes(a)) el.classList.add('selected');
    return el;
  }

  // The lines a text item shows, wrapped to its box if it has a set width.
  function textLines(a, measure) {
    return a.w ? window.PdfEditable.wrapText(a.text, a.w - 2 * TEXT_PADDING, measure) : a.text.split('\n');
  }

  // The selected item, plus the other lines of a highlight made in one drag
  // (they're handled together: one click selects, recolors or deletes them all).
  function selectedItems() {
    const a = getAnnot(state.selectedId);
    if (!a) return [];
    return a.group != null ? state.annots.filter((x) => x.group === a.group && x.page === a.page) : [a];
  }

  function annotEl(id) {
    return ui.pages.querySelector(`.annot[data-id="${id}"]`);
  }

  // Re-render one annotation after a property change. A text box being typed
  // in is styled in place so the caret isn't lost.
  function refreshAnnot(a) {
    scheduleThumbOverlay(a.page);
    const el = annotEl(a.id);
    if (!el) return;
    if (a.id === state.editingId) {
      el.style.color = a.color;
      el.style.fontSize = `${a.size * state.zoom}px`;
    } else {
      el.replaceWith(createAnnotEl(a));
    }
    updateSelectionUi();
  }

  function select(id) {
    if (state.selectedId === id) {
      updateSelectionUi();
      return;
    }
    for (const x of selectedItems()) annotEl(x.id)?.classList.remove('selected');
    state.selectedId = id;
    if (id != null) {
      for (const x of selectedItems()) annotEl(x.id)?.classList.add('selected');
      const a = getAnnot(id);
      if (a) {
        showColor(a.color);
        if (a.type === 'text') ui.sizeInput.value = String(a.size);
        if (a.type === 'rect' || a.type === 'ink') ui.lineInput.value = String(a.width);
        if (a.type === 'rect') ui.fillInput.checked = !!a.fill;
      }
    } else {
      showColor(state.colors[state.tool]);
      ui.lineInput.value = String(state.lineWidth);
      ui.fillInput.checked = state.rectFill;
    }
    updateButtons();
    updateSelectionUi();
  }

  function deleteSelected() {
    const items = selectedItems();
    if (!items.length) return;
    if (items.some((x) => x.id === state.editingId)) state.editingId = null;
    checkpoint();
    state.annots = state.annots.filter((x) => !items.includes(x));
    state.selectedId = null;
    redrawPageOf(items[0]);
    updateButtons();
  }

  function addAnnot(a) {
    checkpoint();
    a.id = state.nextId++;
    state.annots.push(a);
    redrawPageOf(a);
    return a;
  }

  // ------------------------------------------- item menu and resize handles
  //
  // Clicking an added item (with any tool) selects it and shows a small menu
  // above it: colors, Fill (rectangles), Edit text (text boxes) and Delete.
  // Boxes and text boxes also get handles on their edges and corners; drag
  // one to change the size and shape. A text box given a size wraps its text.

  const RESIZABLE = new Set(['text', 'rect', 'whiteout', 'highlight']);
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  const selUi = {
    menu: document.createElement('div'),
    box: document.createElement('div'),
    swatches: document.createElement('div'),
    custom: document.createElement('input'),
    fill: document.createElement('label'),
    fillInput: document.createElement('input'),
    edit: document.createElement('button'),
    del: document.createElement('button'),
    dragging: false,
    colorLive: false,
  };

  (function buildSelectionUi() {
    const { menu, box, swatches, custom, fill, fillInput, edit, del } = selUi;
    menu.className = 'item-menu';
    menu.setAttribute('role', 'toolbar');
    menu.setAttribute('aria-label', 'Selected item');
    menu.hidden = true;
    swatches.className = 'item-swatches';
    for (const color of PALETTE) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch';
      sw.dataset.color = color;
      sw.style.background = color;
      sw.title = color;
      sw.setAttribute('aria-label', `Color ${color}`);
      sw.addEventListener('click', () => setSelectedColor(color, true));
      swatches.append(sw);
    }
    const customWrap = document.createElement('label');
    customWrap.className = 'item-custom';
    customWrap.title = 'Pick any color';
    custom.type = 'color';
    custom.setAttribute('aria-label', 'Pick any color');
    custom.addEventListener('input', () => {
      setSelectedColor(custom.value, !selUi.colorLive); // one undo step per visit to the picker
      selUi.colorLive = true;
    });
    custom.addEventListener('change', () => { selUi.colorLive = false; });
    customWrap.append(custom);

    fill.className = 'item-fill';
    fill.title = 'Fill the rectangle with its color';
    fillInput.type = 'checkbox';
    fill.append(fillInput, document.createTextNode('Fill'));
    fillInput.addEventListener('change', () => {
      const a = getAnnot(state.selectedId);
      if (a?.type !== 'rect') return;
      checkpoint();
      a.fill = fillInput.checked;
      refreshAnnot(a);
    });

    edit.type = 'button';
    edit.className = 'btn item-btn';
    edit.textContent = 'Edit text';
    edit.addEventListener('click', () => {
      const a = getAnnot(state.selectedId);
      if (a?.type === 'text') startEditing(a.id);
    });

    del.type = 'button';
    del.className = 'btn danger item-btn';
    del.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.7 9.5h5.6l.7-9.5M7 6.5v5M9 6.5v5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Delete';
    del.title = 'Delete (Delete key)';
    del.addEventListener('click', deleteSelected);

    const sep = () => Object.assign(document.createElement('span'), { className: 'item-sep' });
    menu.append(swatches, customWrap, sep(), fill, edit, sep(), del);

    box.className = 'resize-box';
    box.hidden = true;
    for (const dir of HANDLES) {
      const h = document.createElement('div');
      h.className = `handle ${dir}`;
      h.dataset.dir = dir;
      h.title = 'Drag to change the size';
      box.append(h);
      attachResize(h, dir);
    }

    // Presses on the menu and handles are theirs, not the page's (which
    // would start drawing, or deselect).
    menu.addEventListener('mousedown', (e) => {
      if (!e.target.closest('input')) e.preventDefault(); // keep typing in the text box
    });
    for (const el of [menu, box]) {
      for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
        el.addEventListener(type, (e) => e.stopPropagation());
      }
    }
  })();

  function setSelectedColor(color, commit) {
    const items = selectedItems();
    if (!items.length) return;
    color = color.toLowerCase();
    if (commit) checkpoint();
    else markChanged();
    for (const a of items) {
      a.color = color;
      refreshAnnot(a);
    }
    showColor(color);
  }

  // The item under the pointer on this page, topmost first (works whatever
  // the tool, even where items let clicks through to the text).
  //
  // Text boxes and other items inside an empty (unfilled) rectangle, or under
  // a highlight, win: the rectangle or highlight is picked only when there's
  // nothing else there (or on the rectangle's border).
  function annotAt(page, e) {
    const slop = 4;
    const tol = slop / state.zoom;
    const pt = pointInPage(page, e);
    const list = state.annots.filter((a) => a.page === page.id);
    let weak = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (a.type === 'ink') {
        const pts = a.points.length > 1 ? a.points : [a.points[0], a.points[0]];
        for (let k = 1; k < pts.length; k++) {
          if (distToSegment(pt, pts[k - 1], pts[k]) <= a.width / 2 + tol) return a.id;
        }
        continue;
      }
      const r = annotEl(a.id)?.getBoundingClientRect();
      if (!r || e.clientX < r.left - slop || e.clientX > r.right + slop || e.clientY < r.top - slop || e.clientY > r.bottom + slop) continue;
      if (a.type === 'rect' && !a.fill) {
        const inner = a.width + tol; // how far in from the edge still counts as the border
        const inside = pt.x > a.x + inner && pt.x < a.x + a.w - inner && pt.y > a.y + inner && pt.y < a.y + a.h - inner;
        if (inside) {
          weak ??= a.id;
          continue;
        }
      }
      if (a.type === 'highlight') {
        weak ??= a.id;
        continue;
      }
      return a.id;
    }
    return weak;
  }

  function distToSegment(p, [x1, y1], [x2, y2]) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / len)) : 0;
    return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
  }

  // Show (or hide) the menu and handles for the current selection.
  function updateSelectionUi() {
    const { menu, box } = selUi;
    const items = selectedItems();
    const a = items[0] && getAnnot(state.selectedId);
    const page = a && state.pageById.get(a.page);
    const els = items.map((x) => annotEl(x.id)).filter(Boolean);
    if (!a || !page || !els.length || !page.wrap.isConnected) {
      menu.hidden = true;
      box.hidden = true;
      return;
    }
    if (menu.parentNode !== page.el) page.el.append(box, menu);

    // Handles: one box, or one text box, that isn't turned sideways.
    const z = state.zoom;
    const resizable = items.length === 1 && RESIZABLE.has(a.type) && !a.rot;
    box.hidden = !resizable;
    box.classList.toggle('text-box', a.type === 'text');
    if (resizable) {
      const r = itemRect(a);
      // A text box's handles sit just outside it, clear of the letters.
      const pad = a.type === 'text' ? 5 : 0;
      Object.assign(box.style, {
        left: `${r.x * z - pad}px`, top: `${r.y * z - pad}px`, width: `${r.w * z + 2 * pad}px`, height: `${r.h * z + 2 * pad}px`,
      });
    }

    menu.hidden = selUi.dragging;
    if (menu.hidden) return;
    selUi.fill.hidden = a.type !== 'rect';
    selUi.fillInput.checked = !!a.fill;
    selUi.edit.hidden = a.type !== 'text' || state.editingId === a.id;
    selUi.fill.previousElementSibling.hidden = selUi.fill.hidden && selUi.edit.hidden; // the divider before them
    selUi.custom.value = a.color;
    for (const sw of selUi.swatches.children) sw.classList.toggle('active', sw.dataset.color === a.color.toLowerCase());

    // Above the item, or below it if there's no room; kept on the page.
    const pr = page.el.getBoundingClientRect();
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      top = Math.min(top, r.top - pr.top);
      bottom = Math.max(bottom, r.bottom - pr.top);
      left = Math.min(left, r.left - pr.left);
      right = Math.max(right, r.right - pr.left);
    }
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const gap = resizable ? 12 : 8;
    const y = top - mh - gap >= 0 ? top - mh - gap : bottom + gap;
    const x = Math.max(0, Math.min((left + right) / 2 - mw / 2, pr.width - mw));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  // An item's box in page units. A text box without a set size measures
  // its text as shown.
  function itemRect(a) {
    if (a.type !== 'text') return { x: a.x, y: a.y, w: a.w, h: a.h };
    if (a.w) {
      const el = annotEl(a.id);
      return { x: a.x, y: a.y, w: a.w, h: el ? el.offsetHeight / state.zoom : a.h };
    }
    const el = annotEl(a.id);
    return { x: a.x, y: a.y, w: el ? el.offsetWidth / state.zoom : 10, h: el ? el.offsetHeight / state.zoom : a.size };
  }

  function attachResize(handle, dir) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const a = getAnnot(state.selectedId);
      const page = a && state.pageById.get(a.page);
      if (!page) return;
      e.preventDefault();
      finishEditing();
      const base = itemRect(a);
      if (a.type === 'text' && !a.w) base.h = Math.max(base.h, a.size * TEXT_LINE_HEIGHT + 2 * TEXT_PADDING);
      drag = { a, page, base, start: pointInPage(page, e), moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { a, base } = drag;
      const pt = pointInPage(drag.page, e);
      const dx = pt.x - drag.start.x;
      const dy = pt.y - drag.start.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 2 / state.zoom) return;
        drag.moved = true;
        checkpoint();
        selUi.dragging = true;
      }
      const minW = a.type === 'text' ? a.size + 2 * TEXT_PADDING : 4;
      const minH = a.type === 'text' ? a.size * TEXT_LINE_HEIGHT + 2 * TEXT_PADDING : 4;
      let { x, y, w, h } = base;
      if (dir.includes('e')) w = Math.max(minW, base.w + dx);
      if (dir.includes('w')) {
        w = Math.max(minW, base.w - dx);
        x = base.x + base.w - w;
      }
      if (dir.includes('s')) h = Math.max(minH, base.h + dy);
      if (dir.includes('n')) {
        h = Math.max(minH, base.h - dy);
        y = base.y + base.h - h;
      }
      Object.assign(a, { x: round(x), y: round(y), w: round(w), h: round(h) });
      refreshAnnot(a);
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      selUi.dragging = false;
      updateSelectionUi();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // -------------------------------------------------------- text editing

  // Clicked an item: a text box opens for typing, anything else is selected.
  function selectOrEdit(id, e) {
    if (getAnnot(id)?.type === 'text') editAt(id, e);
    else select(id);
  }

  // Start editing a text box with the caret at the clicked spot.
  function editAt(id, e) {
    startEditing(id, false);
    const el = annotEl(id);
    if (!el || state.editingId !== id) return;
    let range = null;
    selUi.box.style.visibility = 'hidden'; // look at the text, not the handles over it
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    selUi.box.style.visibility = '';
    if (range && el.contains(range.startContainer)) {
      range.collapse(true);
    } else {
      // Clicked just outside the letters: caret at the end.
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function startEditing(id, caretAtEnd = true) {
    finishEditing();
    const a = getAnnot(id);
    const el = annotEl(id);
    if (!a || !el) return;
    select(id);
    state.editingId = id;
    state.editStart = a.text;
    el.classList.add('editing');
    try {
      el.contentEditable = 'plaintext-only';
    } catch {
      el.contentEditable = 'true';
    }
    el.spellcheck = false;
    updateSelectionUi();
    el.focus();
    if (caretAtEnd) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    el.addEventListener('input', () => {
      a.text = el.innerText.replace(/\n$/, '');
      scheduleThumbOverlay(a.page); // the page viewer shows the text as it's typed
      updateSelectionUi();
      // Unsaved right away (not only once the box is left), so closing the
      // tab warns, and a save that's running knows it missed this.
      if (!state.dirty) {
        markChanged();
        updateButtons();
      } else {
        state.changes++;
      }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    el.addEventListener('blur', () => finishEditing(), { once: true });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        el.blur();
      }
      // Typing stays in the box, but Save / Open / Print still work.
      const appShortcut = (e.ctrlKey || e.metaKey) && !e.altKey && ['s', 'o', 'p'].includes(e.key.toLowerCase());
      if (!appShortcut) e.stopPropagation();
    });
  }

  function finishEditing() {
    const id = state.editingId;
    if (id == null) return;
    state.editingId = null;
    const a = getAnnot(id);
    if (!a) return;
    const el = annotEl(id);
    if (el) a.text = el.innerText.replace(/\n$/, '');
    if (!a.text.trim()) {
      // Empty text box: drop it, and drop the undo step that created it.
      state.annots = state.annots.filter((x) => x !== a);
      if (a.isNew) state.undo.pop();
      state.selectedId = null;
    } else if (!a.isNew && a.text !== state.editStart) {
      const now = a.text;
      a.text = state.editStart;
      checkpoint();
      a.text = now;
    }
    delete a.isNew;
    redrawPageOf(a);
    updateButtons();
    updateSelectionUi();
  }

  // -------------------------------------------------------- pointer input

  const DRAG_RECT_TOOLS = new Set(['highlight', 'whiteout', 'rect']);

  // Pointer handling for one page. Listeners sit on the page element: most
  // tools get events through the annotation layer on top, while in Highlight
  // mode that layer lets events through so the text underneath can be
  // selected letter by letter.
  function attachPageEvents(page) {
    const layer = page.annotLayer;
    const host = page.el;
    let drag = null;

    host.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (state.tool === 'select' && !e.target.closest('.annot')) {
        // Highlights and rectangles let clicks through (to the text and
        // anything inside them); pressing on the selected one moves it.
        const hit = annotAt(page, e);
        if (hit == null || !selectedItems().some((x) => x.id === hit)) return;
        e.preventDefault();
        e.stopPropagation(); // not a click on empty space: keep the selection
        finishEditing();
        const items = selectedItems();
        drag = { kind: 'move', items, start: pointInPage(page, e), orig: JSON.stringify(items), moved: false };
        host.setPointerCapture(e.pointerId);
        return;
      }
      const target = e.target.closest('.annot');
      const id = target ? Number(target.dataset.id) : null;
      if (id != null && id === state.editingId) return; // clicks inside the box being edited
      const pt = pointInPage(page, e);
      const tool = state.tool;
      // With a drawing tool, an existing item under the pointer: a click
      // (no drag) selects it, and dragging the selected item moves it.
      const hitId = tool === 'select' ? null : annotAt(page, e);
      const hitSelected = hitId != null && tool !== 'text' && selectedItems().some((x) => x.id === hitId);

      if (tool === 'select' || hitSelected) {
        if (id == null && !hitSelected) return;
        e.preventDefault();
        finishEditing();
        if (!hitSelected) select(id);
        const items = selectedItems();
        drag = { kind: 'move', items, start: pt, orig: JSON.stringify(items), moved: false };
      } else if (tool === 'text') {
        if (id != null && getAnnot(id)?.type === 'text') {
          // Into the existing box: the browser puts the caret where it was
          // clicked, and dragging selects its text.
          startEditing(id, false);
          return;
        }
        e.preventDefault();
        finishEditing();
        const size = state.fontSize;
        const a = addAnnot({
          page: page.id, type: 'text', text: '',
          x: pt.x - TEXT_PADDING, y: pt.y - size * TEXT_LINE_HEIGHT / 2 - TEXT_PADDING,
          size, color: state.colors.text, isNew: true,
        });
        startEditing(a.id);
        return;
      } else if (tool === 'highlight' && hitText(page, pt, true)) {
        // Pressed on or near text: highlight letters, following the lines.
        e.preventDefault();
        finishEditing();
        select(null);
        const anchor = hitText(page, pt, true);
        drag = { kind: 'textHighlight', anchor, focus: anchor, drafts: [], start: pt, last: pt, hitId };
      } else if (DRAG_RECT_TOOLS.has(tool)) {
        e.preventDefault();
        finishEditing();
        select(null);
        const proto = { type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: state.colors[tool], width: state.lineWidth, fill: state.rectFill };
        const el = createAnnotEl(proto);
        el.classList.add('draft');
        if (tool === 'whiteout') el.style.outline = '1px dashed #999';
        layer.append(el);
        drag = { kind: 'rect', tool, start: pt, el, cur: pt, hitId };
      } else if (tool === 'draw') {
        e.preventDefault();
        finishEditing();
        select(null);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'annot draft ink');
        Object.assign(svg.style, { left: 0, top: 0, width: '100%', height: '100%' });
        svg.setAttribute('viewBox', `0 0 ${page.vp.width} ${page.vp.height}`);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', state.colors.draw);
        line.setAttribute('stroke-width', state.lineWidth);
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('stroke-linejoin', 'round');
        svg.append(line);
        layer.append(svg);
        drag = { kind: 'ink', points: [[round(pt.x), round(pt.y)]], svg, line, hitId };
      }
      if (drag) host.setPointerCapture(e.pointerId);
    });

    host.addEventListener('pointermove', (e) => {
      if (!drag) {
        // Highlight tool: show a text cursor near text, a crosshair elsewhere.
        if (state.tool === 'highlight') host.style.cursor = hitText(page, pointInPage(page, e), true) ? 'text' : 'crosshair';
        return;
      }
      const pt = pointInPage(page, e);
      if (drag.kind === 'textHighlight') {
        drag.last = pt;
        drag.focus = hitText(page, pt, false) || drag.focus;
        drag.moved = true;
        showHighlightDrafts(page, drag, textSelectionRects(page, drag.anchor, drag.focus));
        return;
      }
      if (drag.kind === 'move') {
        const dx = pt.x - drag.start.x;
        const dy = pt.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) < 2 / state.zoom) return;
        if (!drag.moved) {
          drag.moved = true;
          checkpoint();
          drag.base = JSON.parse(drag.orig);
          selUi.dragging = true; // the menu steps aside while moving
        }
        drag.items.forEach((x, i) => moveAnnot(x, drag.base[i], dx, dy));
        drag.items.forEach(refreshAnnot);
      } else if (drag.kind === 'rect') {
        drag.cur = pt;
        const r = normRect(drag.start, pt);
        const z = state.zoom;
        Object.assign(drag.el.style, { left: `${r.x * z}px`, top: `${r.y * z}px`, width: `${r.w * z}px`, height: `${r.h * z}px` });
      } else if (drag.kind === 'ink') {
        drag.points.push([round(pt.x), round(pt.y)]);
        drag.line.setAttribute('points', drag.points.map((p) => p.join(',')).join(' '));
      }
    });

    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      const isClick = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 3 / state.zoom;
      if (d.kind === 'move') {
        selUi.dragging = false;
        // A click (no drag) on a text box goes into it, caret where clicked.
        if (!d.moved && e.type === 'pointerup' && d.items.length === 1 && d.items[0].type === 'text') {
          editAt(d.items[0].id, e);
        } else {
          updateSelectionUi();
        }
      } else if (d.kind === 'textHighlight') {
        showHighlightDrafts(page, d, []);
        if (d.hitId != null && isClick(d.start, d.last)) selectOrEdit(d.hitId, e);
        else if (d.moved && e.type !== 'pointercancel') addHighlights(page, textSelectionRects(page, d.anchor, d.focus));
      } else if (d.kind === 'rect') {
        d.el.remove();
        const r = normRect(d.start, d.cur);
        if (d.hitId != null && isClick(d.start, d.cur)) {
          selectOrEdit(d.hitId, e);
        } else if (r.w > 2 && r.h > 2) {
          const a = { page: page.id, type: d.tool, ...r, color: state.colors[d.tool] };
          if (d.tool === 'rect') Object.assign(a, { width: state.lineWidth, fill: state.rectFill });
          addAnnot(a);
        }
      } else if (d.kind === 'ink') {
        d.svg.remove();
        const [x0, y0] = d.points[0];
        if (d.hitId != null && d.points.every(([x, y]) => isClick({ x: x0, y: y0 }, { x, y }))) {
          selectOrEdit(d.hitId, e);
        } else if (e.type !== 'pointercancel') {
          addAnnot({ page: page.id, type: 'ink', points: d.points, color: state.colors.draw, width: state.lineWidth });
        }
      }
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);

    // Stop the browser from moving focus / starting a text selection when we
    // handle the press ourselves (otherwise a new text box would lose focus).
    host.addEventListener('mousedown', (e) => {
      if (state.tool === 'select' && !e.target.closest('.annot')) return;
      const target = e.target.closest('.annot');
      if (target && Number(target.dataset.id) === state.editingId) return;
      if (state.tool !== 'select' || target) e.preventDefault();
    });

    // Double-click a text box to edit it. (The pointer is captured while
    // pressing, so the event's target is the layer; look at what's under it.)
    host.addEventListener('dblclick', (e) => {
      if (state.tool === 'highlight') {
        // Double-click a word to highlight it.
        const hit = hitText(page, pointInPage(page, e), true);
        if (hit) addHighlights(page, wordRects(page, hit));
        return;
      }
      if (state.tool !== 'select') return;
      const target = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('.annot.txt'));
      if (target && Number(target.dataset.id) !== state.editingId) editAt(Number(target.dataset.id), e);
    });
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function normRect(a, b) {
    return {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
    };
  }

  function moveAnnot(a, base, dx, dy) {
    if (a.type === 'ink') {
      a.points = base.points.map(([x, y]) => [round(x + dx), round(y + dy)]);
    } else {
      a.x = base.x + dx;
      a.y = base.y + dy;
    }
  }

  // Clicking empty page space in select mode deselects.
  ui.pages.addEventListener('pointerdown', (e) => {
    if (state.tool === 'select' && e.target.closest('.page') && !e.target.closest('.annot')) select(null);
  });

  // Highlights and rectangles let clicks through so the text under them stays
  // selectable; a plain click (no text selected) on one selects it instead.
  ui.pages.addEventListener('click', (e) => {
    if (state.tool !== 'select' || e.target.closest('.annot')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const page = pageAt(e.target);
    if (!page) return;
    const hit = annotAt(page, e);
    if (hit != null) select(hit);
  });

  // ------------------------------------------------ highlight selected text

  // ------------------------------------------- text-aware highlighter
  //
  // The Highlight tool works from the positions of the page's letters rather
  // than the browser's text selection (which has tiny targets and jumps
  // around, and runs across columns). Letters are grouped into lines, and
  // each line is split where there's a wide gap (between columns). A drag
  // highlights from the letter where it started to the letter nearest the
  // pointer, only within the column(s) the drag covers.
  //
  // Positions are worked out with the page turned back upright, so rotated
  // pages behave the same.

  function textIndex(page) {
    if (page.textIndex) return page.textIndex;
    const q = (((page.vp.rotation / 90) % 4) + 4) % 4;
    const W = page.vp.width;
    const H = page.vp.height;
    const upright = (x, y) => turnPoint(x, y, W, H, (4 - q) % 4);
    const pr = page.el.getBoundingClientRect();
    const z = state.zoom;
    const range = document.createRange();
    const chars = [];
    for (const span of page.el.querySelectorAll('.textLayer span, .ocrLayer span')) {
      const node = span.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      for (let i = 0; i < node.data.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width < 0.1 || r.height < 0.1) continue;
        const [ax, ay] = upright((r.left - pr.left) / z, (r.top - pr.top) / z);
        const [bx, by] = upright((r.right - pr.left) / z, (r.bottom - pr.top) / z);
        const c = { x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by), space: !node.data[i].trim() };
        c.h = c.y1 - c.y0;
        c.cy = (c.y0 + c.y1) / 2;
        chars.push(c);
      }
    }
    // Lines: letters whose middles are at about the same height.
    chars.sort((a, b) => a.cy - b.cy);
    const lines = [];
    for (const c of chars) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(c.cy - line.cy) < 0.5 * Math.min(c.h, line.h)) line.chars.push(c);
      else lines.push({ cy: c.cy, h: c.h, chars: [c] });
    }
    // Segments: pieces of a line separated by a wide gap (column gutters).
    const segs = [];
    lines.forEach((line, li) => {
      line.chars.sort((a, b) => a.x0 - b.x0);
      let seg = null;
      for (const c of line.chars) {
        if (!seg || c.x0 - seg.x1 > Math.max(1.5 * c.h, 8)) {
          seg = { line: li, chars: [], x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 };
          segs.push(seg);
        }
        c.line = li;
        seg.chars.push(c);
        seg.x1 = Math.max(seg.x1, c.x1);
        seg.y0 = Math.min(seg.y0, c.y0);
        seg.y1 = Math.max(seg.y1, c.y1);
      }
    });
    page.textIndex = { segs: segs.filter((sg) => sg.chars.some((c) => !c.space)), upright, q, uW: q % 2 ? H : W, uH: q % 2 ? W : H };
    return page.textIndex;
  }

  // The letter position nearest a point: { seg, k } meaning "before letter k
  // of seg". With `strict`, only if the point is on or close to the text
  // (a generous margin above, below and beside each line).
  function hitText(page, pt, strict) {
    const idx = textIndex(page);
    if (!idx.segs.length) return null;
    const [x, y] = idx.upright(pt.x, pt.y);
    let best = null;
    let bestScore = Infinity;
    for (const sg of idx.segs) {
      const h = sg.y1 - sg.y0;
      const dy = y < sg.y0 ? sg.y0 - y : y > sg.y1 ? y - sg.y1 : 0;
      const dx = x < sg.x0 ? sg.x0 - x : x > sg.x1 ? x - sg.x1 : 0;
      if (strict && (dy > 0.6 * h || dx > 1.2 * h)) continue;
      const score = dy * 3 + dx; // stick to the nearest line
      if (score < bestScore) {
        best = sg;
        bestScore = score;
      }
    }
    if (!best) return null;
    let k = best.chars.findIndex((c) => x < (c.x0 + c.x1) / 2);
    if (k < 0) k = best.chars.length;
    return { seg: best, k };
  }

  // Back from upright positions to the page as displayed.
  function displayRect(idx, x0, y0, x1, y1) {
    const [ax, ay] = turnPoint(x0, y0, idx.uW, idx.uH, idx.q);
    const [bx, by] = turnPoint(x1, y1, idx.uW, idx.uH, idx.q);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }

  // One rectangle per line piece (separately in each column) for the letters from `a` to `b`.
  function textSelectionRects(page, a, b) {
    const idx = textIndex(page);
    if (!a || !b) return [];
    // Only the column(s) the drag covers, between its top and bottom lines.
    const left = Math.min(a.seg.x0, b.seg.x0);
    const right = Math.max(a.seg.x1, b.seg.x1);
    const top = Math.min(a.seg.y0, b.seg.y0);
    const bottom = Math.max(a.seg.y1, b.seg.y1);
    const segs = idx.segs
      .filter((sg) => sg === a.seg || sg === b.seg ||
        (sg.x1 > left && sg.x0 < right && sg.y1 > top && sg.y0 < bottom))
      .sort((p, q) => p.line - q.line || p.x0 - q.x0);
    let from = { i: segs.indexOf(a.seg), k: a.k };
    let to = { i: segs.indexOf(b.seg), k: b.k };
    if (to.i < from.i || (to.i === from.i && to.k < from.k)) [from, to] = [to, from];
    const rects = [];
    for (let i = from.i; i <= to.i; i++) {
      const sg = segs[i];
      const picked = sg.chars.slice(i === from.i ? from.k : 0, i === to.i ? to.k : sg.chars.length).filter((c) => !c.space);
      if (!picked.length) continue;
      rects.push(displayRect(idx,
        Math.min(...picked.map((c) => c.x0)), Math.min(...picked.map((c) => c.y0)),
        Math.max(...picked.map((c) => c.x1)), Math.max(...picked.map((c) => c.y1))));
    }
    return rects;
  }

  // The word around a letter position.
  function wordRects(page, hit) {
    const chars = hit.seg.chars;
    let i = Math.min(hit.k, chars.length - 1);
    if (chars[i].space && i > 0 && !chars[i - 1].space) i--;
    if (chars[i].space) return [];
    let s0 = i;
    let s1 = i;
    while (s0 > 0 && !chars[s0 - 1].space) s0--;
    while (s1 < chars.length - 1 && !chars[s1 + 1].space) s1++;
    return textSelectionRects(page, { seg: hit.seg, k: s0 }, { seg: hit.seg, k: s1 + 1 });
  }

  // Live preview of the highlight while dragging.
  function showHighlightDrafts(page, drag, rects) {
    for (const el of drag.drafts) el.remove();
    drag.drafts = rects.map((r) => {
      const el = createAnnotEl({ type: 'highlight', ...r, color: state.colors.highlight });
      el.classList.add('draft');
      page.annotLayer.append(el);
      return el;
    });
  }

  function addHighlights(page, rects) {
    if (!rects.length) return;
    checkpoint();
    // The lines of one highlight stay together (one click selects them all).
    const group = rects.length > 1 ? `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : null;
    for (const r of rects) {
      state.annots.push({ id: state.nextId++, page: page.id, type: 'highlight', ...r, color: state.colors.highlight, ...(group ? { group } : {}) });
    }
    drawAnnots(page);
  }

  // While selecting with the Highlight tool, the selection shows in the highlight color.
  function updateHighlightPreview() {
    const n = parseInt(state.colors.highlight.slice(1), 16);
    document.body.style.setProperty('--hl-preview', `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.5)`);
  }

  function highlightSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const rectsByPage = new Map();
    const list = pages();
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const r of sel.getRangeAt(i).getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const page = list.find((p) => {
          const pr = p.el.getBoundingClientRect();
          return cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom;
        });
        if (!page) continue;
        const pr = page.el.getBoundingClientRect();
        const z = state.zoom;
        const rect = { x: (r.left - pr.left) / z, y: (r.top - pr.top) / z, w: r.width / z, h: r.height / z };
        if (!rectsByPage.has(page.id)) rectsByPage.set(page.id, []);
        rectsByPage.get(page.id).push(rect);
      }
    }
    if (!rectsByPage.size) return false;
    checkpoint();
    for (const [id, rects] of rectsByPage) {
      for (const r of mergeLineRects(rects)) {
        state.annots.push({ id: state.nextId++, page: id, type: 'highlight', ...r, color: state.colors.highlight });
      }
      drawAnnots(state.pageById.get(id));
    }
    sel.removeAllRanges();
    setStatus('Highlighted selected text.');
    return true;
  }

  // Merge rectangles that sit on the same line and touch, so overlapping
  // highlights don't stack into darker patches.
  function mergeLineRects(rects) {
    rects.sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const r of rects) {
      const last = out[out.length - 1];
      const sameLine = last && Math.abs((last.y + last.h / 2) - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5;
      if (sameLine && r.x <= last.x + last.w + 2) {
        const x2 = Math.max(last.x + last.w, r.x + r.w);
        const y1 = Math.min(last.y, r.y);
        const y2 = Math.max(last.y + last.h, r.y + r.h);
        last.x = Math.min(last.x, r.x);
        last.w = x2 - last.x;
        last.y = y1;
        last.h = y2 - y1;
      } else {
        out.push({ ...r });
      }
    }
    return out;
  }

  // ---------------------------------------------------- tools and styling

  function setTool(tool) {
    if (tool === 'highlight' && state.tool === 'select' && highlightSelection()) return;
    finishEditing();
    state.tool = tool;
    document.body.dataset.tool = tool;
    for (const p of allPages()) p.el.style.cursor = '';
    ui.toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    if (tool !== 'select') select(null);
    showColor(state.colors[tool]);
  }

  ui.toolButtons.forEach((btn) => {
    // Keep any text selection alive so "select text, then Highlight" works.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // Palette swatches, plus the browser's color picker for any other color.
  for (const color of PALETTE) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.dataset.color = color;
    sw.style.background = color;
    sw.title = color;
    sw.setAttribute('aria-label', `Color ${color}`);
    // Don't take focus, so a text box being typed in stays active.
    sw.addEventListener('mousedown', (e) => e.preventDefault());
    sw.addEventListener('click', () => applyColor(color, true));
    ui.palette.append(sw);
  }

  function showColor(color) {
    ui.colorInput.value = color;
    for (const sw of ui.palette.children) sw.classList.toggle('active', sw.dataset.color === color.toLowerCase());
  }

  // Change the color of the selected item (if any) and of the current tool.
  function applyColor(color, commit) {
    color = color.toLowerCase();
    showColor(color);
    const items = selectedItems();
    if (items.length) {
      if (commit) checkpoint();
      else markChanged();
      for (const a of items) {
        a.color = color;
        refreshAnnot(a);
      }
      state.colors[toolFor(items[0].type)] = color;
    }
    state.colors[state.tool] = color;
    updateHighlightPreview();
  }

  ui.colorInput.addEventListener('input', () => {
    // One undo step per visit to the picker, not one per tiny drag.
    applyColor(ui.colorInput.value, !state.colorLive);
    state.colorLive = true;
  });
  ui.colorInput.addEventListener('change', () => {
    state.colorLive = false;
  });

  // Apply a property change to the selected item if it has that property.
  function applyToSelected(types, apply) {
    const a = getAnnot(state.selectedId);
    if (!a || !types.includes(a.type)) return;
    checkpoint();
    apply(a);
    refreshAnnot(a);
  }

  ui.sizeInput.addEventListener('change', () => {
    state.fontSize = Number(ui.sizeInput.value);
    applyToSelected(['text'], (a) => { a.size = state.fontSize; });
  });

  ui.lineInput.addEventListener('change', () => {
    state.lineWidth = Number(ui.lineInput.value);
    applyToSelected(['rect', 'ink'], (a) => { a.width = state.lineWidth; });
  });

  ui.fillInput.addEventListener('change', () => {
    state.rectFill = ui.fillInput.checked;
    applyToSelected(['rect'], (a) => { a.fill = state.rectFill; });
  });

  // Hand focus back after using a toolbar control so tool shortcuts keep working.
  for (const control of [ui.sizeInput, ui.lineInput, ui.fillInput, ui.colorInput]) {
    control.addEventListener('change', () => control.blur());
  }

  // ------------------------------------------------------------- OCR

  async function runOcr() {
    if (!state.order.length || state.busy) return;
    finishEditing();
    setStatus('Checking which pages need text recognition…');
    await state.textReady;
    let targets = pages().filter((p) => (p.charCount ?? 0) < MIN_CHARS_FOR_TEXT_PAGE && !state.ocr[p.id]);
    if (!targets.length) {
      const again = confirm(
        'Every page already has searchable text, so Ctrl+F should already work.\n\n' +
        'Run text recognition (OCR) on all pages anyway? Use this if searching still misses words.');
      if (!again) {
        setStatus('Every page already has searchable text.');
        return;
      }
      targets = pages();
    }
    if (typeof Tesseract === 'undefined') {
      alert('The OCR engine could not be loaded. Check your internet connection and reload the page.');
      return;
    }

    state.busy = true;
    state.busyLabel = 'reading the text on scanned pages (Make searchable)';
    updateButtons();
    let worker;
    const before = snapshot();
    let done = 0;
    try {
      setStatus('Loading text recognition engine (first time can take a little while)…');
      setProgress(0);
      worker = await Tesseract.createWorker('eng', 1, {
        workerPath: CDN.tessWorker,
        corePath: CDN.tessCore,
        langPath: CDN.tessLang,
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress((done + m.progress) / targets.length);
        },
      });
      for (const page of targets) {
        const pos = state.order.indexOf(page.id) + 1;
        setStatus(`Recognizing text on page ${pos} (${done + 1} of ${targets.length})…`);
        state.ocr[page.id] = await ocrPage(worker, page);
        drawOcrLayer(page);
        done++;
        setProgress(done / targets.length);
      }
      state.undo.push(before);
      state.redo = [];
      markChanged();
      const total = targets.reduce((n, p) => n + (state.ocr[p.id]?.length || 0), 0);
      setStatus(`OCR finished: found ${total} words on ${targets.length} page${targets.length === 1 ? '' : 's'}. ` +
        'Click Save (Ctrl+S) to keep the searchable PDF.');
    } catch (err) {
      console.error(err);
      if (done) {
        state.undo.push(before);
        markChanged();
      }
      setStatus(`OCR failed: ${err.message || err}`);
    } finally {
      if (worker) await worker.terminate().catch(() => {});
      state.busy = false;
      setProgress(null);
      updateButtons();
    }
  }

  async function ocrPage(worker, page) {
    const base = page.vp;
    const scale = Math.min(OCR_DPI / 72, OCR_MAX_CANVAS / Math.max(base.width, base.height));
    const viewport = viewportOf(page, scale);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.pdfPage.render({ canvasContext: ctx, viewport }).promise;

    const { data } = await worker.recognize(canvas);
    const words = [];
    for (const line of data.lines || []) {
      const lineTop = line.bbox.y0;
      for (const w of line.words || []) {
        const text = (w.text || '').trim();
        if (!text || w.confidence < 15) continue;
        const b = w.bbox;
        let baseline = b.y1;
        if (w.baseline && w.baseline.has_baseline !== false && Number.isFinite(w.baseline.y0)) {
          // Baseline is a line through the word; take its height at the word's midpoint.
          const { x0, y0, x1, y1 } = w.baseline;
          const mid = (b.x0 + b.x1) / 2;
          baseline = x1 !== x0 ? y0 + ((y1 - y0) * (mid - x0)) / (x1 - x0) : (y0 + y1) / 2;
          if (baseline < b.y0 || baseline > b.y1) baseline = b.y1;
        }
        const top = Math.min(lineTop, b.y0);
        words.push({
          text,
          x: round(b.x0 / scale),
          w: round((b.x1 - b.x0) / scale),
          baseline: round(baseline / scale),
          // Ascender height ≈ 0.72 of the font size for typical Latin fonts.
          size: round(Math.max(2, (baseline - top) / scale / 0.72)),
        });
      }
    }
    canvas.width = canvas.height = 0;
    return words;
  }

  const measureCtx = document.createElement('canvas').getContext('2d');

  function drawOcrLayer(page) {
    page.textIndex = null;
    const layer = page.ocrLayer;
    layer.textContent = '';
    const words = state.ocr[page.id];
    if (!words) return;
    const z = state.zoom;
    const frag = document.createDocumentFragment();
    for (const w of words) {
      const span = document.createElement('span');
      span.textContent = `${w.text} `;
      const size = w.size * z;
      measureCtx.font = `${size}px ${FONT_FAMILY}`;
      const natural = measureCtx.measureText(w.text).width || 1;
      span.style.left = `${w.x * z}px`;
      span.style.top = `${(w.baseline - w.size * 0.8) * z}px`;
      span.style.fontSize = `${size}px`;
      // Turn around the start of the baseline when the page has been rotated.
      span.style.transformOrigin = `0 ${0.8 * size}px`;
      span.style.transform = `${w.rot ? `rotate(${w.rot}deg) ` : ''}scaleX(${(w.w * z) / natural})`;
      frag.append(span);
    }
    layer.append(frag);
  }

  // ------------------------------------------------------------- saving

  // Load one source file with pdf-lib so it can be saved. Problems are fixed
  // automatically where possible:
  //   protected (encrypted)  -> unlocked with qpdf
  //   damaged / unreadable    -> repaired with qpdf
  //   still unreadable        -> rebuilt from the pages as the editor shows them
  async function loadForSaving(source, { repair = false } = {}) {
    const L = PDFLib;
    // pdf-lib can "load" some broken files that then fail later, so also
    // check that every page can be read.
    const load = async (data) => {
      const doc = await L.PDFDocument.load(data);
      doc.getPages();
      return doc;
    };
    let bytes = source.bytes;
    if (repair) return rebuildFromView(source);
    try {
      return await load(bytes);
    } catch (err) {
      if (/encrypt/i.test(err.message)) {
        // Uses the password typed when it was opened (none is needed for
        // files that only restrict editing or printing).
        setStatus(`Unlocking ${source.name} so it can be saved…`);
        try {
          source.unlocked ??= await unlockPdf(source.bytes, source.password || '');
        } catch (unlockErr) {
          console.warn('Unlock failed; rebuilding instead', unlockErr);
          return rebuildFromView(source);
        }
        source.wasProtected = true;
        bytes = source.unlocked;
        try {
          return await load(bytes);
        } catch (afterUnlock) {
          console.warn('Unlocked file still unreadable', afterUnlock);
        }
      } else {
        console.warn(`${source.name} couldn't be read for saving; repairing`, err);
      }
    }
    setStatus(`Repairing ${source.name}…`);
    try {
      source.repaired ??= await repairPdf(bytes);
      const doc = await load(source.repaired);
      source.saveNote = `${source.name} was slightly damaged and has been repaired.`;
      return doc;
    } catch (repairErr) {
      console.warn('Repair failed; rebuilding from the displayed pages', repairErr);
    }
    return rebuildFromView(source);
  }

  // Last resort for a file nothing else can read: make a new PDF from what the
  // editor displays. Each page becomes a high-resolution picture with the
  // page's real text invisibly on top, so it looks the same and stays
  // searchable. The page size and position match the original exactly, so
  // edits land where they were made.
  async function rebuildFromView(source) {
    const L = PDFLib;
    setStatus(`Rebuilding ${source.name} so it can be saved…`);
    const out = await L.PDFDocument.create();
    const font = await out.embedFont(L.StandardFonts.Helvetica);
    const clean = makeSanitizer(font);
    for (let i = 1; i <= source.doc.numPages; i++) {
      const pdfPage = await source.doc.getPage(i);
      const [x0, y0, x1, y1] = pdfPage.view;
      const width = x1 - x0;
      const height = y1 - y0;
      const scale = Math.min(200 / 72, 4000 / Math.max(width, height));
      const viewport = pdfPage.getViewport({ scale, rotation: 0 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      canvas.width = canvas.height = 0;

      const page = out.addPage([width, height]);
      page.setMediaBox(x0, y0, width, height);
      page.setRotation(L.degrees(pdfPage.rotate));
      page.drawImage(image, { x: x0, y: y0, width, height });
      // The page's own text, at its original position, invisible.
      const content = await pdfPage.getTextContent();
      const words = [];
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const [a, b, , d, e, f] = item.transform;
        words.push({ text: item.str, x: e, baseline: f, w: item.width, size: Math.hypot(a, b) || Math.abs(d) || 10,
          rot: -(Math.atan2(b, a) * 180) / Math.PI });
      }
      if (words.length) writeInvisibleText(page, font, clean, words, (x, y) => [x, y], 0);
    }
    source.saveNote = `${source.name} was damaged, so its pages were saved as high-quality images (the text is still searchable).`;
    return out;
  }

  // Build the output document with the pages in state.order. When the first
  // file's pages are still in their original order (some may be deleted) and
  // any other files' pages come after them, edit that file in place so its
  // bookmarks, metadata and form fields survive. Otherwise assemble a new PDF.
  async function assemblePages({ repair = false } = {}) {
    const L = PDFLib;
    const list = pages();
    const libDocs = new Map();
    const lib = async (src) => {
      if (!libDocs.has(src)) libDocs.set(src, await loadForSaving(state.sources[src], { repair }));
      return libDocs.get(src);
    };

    let inPlace = list.some((p) => p.src === 0);
    let last = -1;
    let seenOther = false;
    for (const p of list) {
      if (p.src !== 0) {
        seenOther = true;
      } else if (seenOther || p.srcIndex < last) {
        inPlace = false;
        break;
      } else {
        last = p.srcIndex;
      }
    }

    let out;
    let toCopy;
    if (inPlace) {
      out = await lib(0);
      const keep = new Set(list.filter((p) => p.src === 0).map((p) => p.srcIndex));
      for (let i = out.getPageCount() - 1; i >= 0; i--) {
        if (!keep.has(i)) out.removePage(i);
      }
      toCopy = list.filter((p) => p.src !== 0);
    } else {
      out = await L.PDFDocument.create();
      toCopy = list;
    }

    // Copy pages from each source in one batch, so shared fonts/images are copied once.
    const copied = new Map();
    const bySource = new Map();
    for (const p of toCopy) {
      if (!bySource.has(p.src)) bySource.set(p.src, []);
      bySource.get(p.src).push(p);
    }
    for (const [src, srcPages] of bySource) {
      const cps = await out.copyPages(await lib(src), srcPages.map((p) => p.srcIndex));
      srcPages.forEach((p, k) => copied.set(p.id, cps[k]));
    }
    for (const p of toCopy) out.addPage(copied.get(p.id));
    return out;
  }

  // Build the edited PDF (pages in order, rotations, edits, OCR text) as bytes.
  async function buildPdf({ repair = false } = {}) {
    const L = PDFLib;
    const out = await assemblePages({ repair });
    const font = await out.embedFont(L.StandardFonts.Helvetica);
    const clean = makeSanitizer(font);
    const outPages = out.getPages();

    pages().forEach((page, i) => {
      const target = outPages[i];
      target.setRotation(L.degrees(page.vp.rotation));
      const annots = state.annots.filter((a) => a.page === page.id);
      const words = state.ocr[page.id] || [];
      if (!annots.length && !words.length) return;
      // Wrap the existing content in q/Q so its graphics state can't skew our additions.
      target.translateContent(0, 0);
      const vp = page.vp;
      const rot = vp.rotation;
      const toPdf = (x, y) => vp.convertToPdfPoint(x, y);

      if (words.length) writeInvisibleText(target, font, clean, words, toPdf, rot);

      // Edits are saved as standard PDF annotations that stay editable (editable.js).
      window.PdfEditable.writeItems(out, target, annots, {
        vp, font, clean, writeInvisibleText,
        text: { padding: TEXT_PADDING, lineHeight: TEXT_LINE_HEIGHT, baseline: BASELINE_RATIO },
        highlightOpacity: HIGHLIGHT_OPACITY,
      });
    });

    return out.save();
  }

  const canPickSaveFile = typeof window.showSaveFilePicker === 'function';

  // Save the document. In Chrome and Edge the first save asks where to put
  // the file, and later saves (Ctrl+S) update that same file; Save As
  // (Ctrl+Shift+S) asks again. Other browsers download a copy each time.
  //
  // Whenever a save doesn't happen, a "Not saved" popup says so and why.
  async function save({ saveAs = false } = {}) {
    if (!state.order.length) {
      await notSaved('There is nothing to save yet. Open a file first.');
      return;
    }
    if (state.savePending) return; // a save is already waiting to happen
    finishEditing();

    // Ask for the location (or for permission to update the file chosen
    // before) right away, while the click / key press still counts as the
    // person's action — browsers only allow these in response to one.
    let handle = saveAs ? null : state.saveHandle;
    if (handle && !(await hasWritePermission(handle))) handle = null;
    if (canPickSaveFile && !handle) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: outputName(),
          types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (err) {
        if (err.name === 'AbortError') {
          setStatus('Not saved.');
          const retry = await notSaved('The save window was closed without choosing where to save, so your changes have not been saved.',
            { retry: 'Choose where to save' });
          if (retry) save({ saveAs });
          return;
        }
        console.warn('Save dialog unavailable, downloading instead:', err);
        handle = null;
      }
    }

    // Busy (opening files, reading a scan, another save…)? Save as soon as it's done.
    if (state.busy) {
      state.savePending = true;
      setStatus(`Will save as soon as PDF Editor finishes ${state.busyLabel || 'what it is doing'}…`);
      while (state.busy) await new Promise((resolve) => setTimeout(resolve, 200));
      state.savePending = false;
      finishEditing();
    }

    state.busy = true;
    state.busyLabel = 'saving';
    updateButtons();
    setStatus('Saving…');
    let bytes = null;
    let name = outputName();
    let failure = null;
    let savedToDownloadsInstead = null;
    try {
      // The PDF tools may have failed to load (e.g. the connection dropped): try again.
      try {
        await ensurePdfLib();
      } catch {
        throw new Error('the PDF tools could not be loaded. Check your internet connection and save again (keep this page open so your changes are not lost). The installable offline app avoids this.');
      }
      for (const src of state.sources) src.saveNote = null;
      const changesSaved = state.changes; // anything changed after this point isn't in this save
      try {
        bytes = await buildPdf();
      } catch (err) {
        // Something in a file tripped up the save: rebuild every file from
        // its displayed pages and try once more.
        console.warn('Save failed; retrying with all files rebuilt', err);
        setStatus('Saving… (repairing the document)');
        bytes = await buildPdf({ repair: true });
      }

      // Like Acrobat, a file that needed a password to open keeps that
      // password when saved. (Edit/print restrictions are not put back.)
      const used = [...new Set(pages().map((p) => state.sources[p.src]))];
      const withPassword = used.find((src) => src.password);
      let note = used.some((src) => src.wasProtected && !src.password) ? ' Its editing restrictions were removed so it could be changed.' : '';
      if (withPassword) {
        setStatus('Adding password…');
        bytes = await lockPdf(bytes, withPassword.password);
        note = ' It still needs its password to open.';
      }
      for (const src of used) if (src.saveNote) note += ` ${src.saveNote}`;

      if (handle) {
        try {
          await writeToFile(handle, bytes);
          state.saveHandle = handle;
          name = handle.name;
        } catch (err) {
          // The chosen file can't be written (e.g. it's open in another
          // program). Don't lose the work: save a copy to Downloads instead.
          console.warn(err);
          download(bytes, name);
          savedToDownloadsInstead = { file: handle.name, reason: err.message };
          state.saveHandle = handle; // the next Ctrl+S tries that file again
          note += ' It is in your Downloads folder.';
        }
      } else {
        download(bytes, name);
        note += ' It is in your Downloads folder.';
      }
      // Changes made while saving weren't in this copy: they stay unsaved.
      state.dirty = state.changes !== changesSaved;
      if (state.dirty) note += ' Changes you made while it was saving aren\'t in it yet: press Ctrl+S again.';
      setStatus(`${handle && !savedToDownloadsInstead ? 'Saved changes to' : 'Saved'} ${name}.${note}`);
    } catch (err) {
      console.error(err);
      failure = err;
      setStatus(`Not saved: ${err.message || err}`);
    } finally {
      state.busy = false;
      updateButtons();
    }

    if (savedToDownloadsInstead) {
      await askConfirm(
        `"${savedToDownloadsInstead.file}" couldn't be updated, so your work was saved as "${name}" in your Downloads folder instead. ` +
        `This usually means the file is open in another program, like Acrobat. Close it there and press Ctrl+S to save to "${savedToDownloadsInstead.file}" again. ` +
        `(Details: ${savedToDownloadsInstead.reason})`,
        { title: 'Saved to Downloads instead', yes: null, no: 'OK', danger: false });
    } else if (failure) {
      if (await notSaved(`Your changes have not been saved. ${capitalize(failure.message || String(failure))}`, { retry: 'Try again' })) {
        save({ saveAs });
      }
    }
  }

  // Can we still write to the file chosen earlier? Asks again if the browser
  // has since withdrawn permission (Chrome does this after a while).
  async function hasWritePermission(handle) {
    if (!handle.queryPermission) return true;
    try {
      if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  // Write the PDF to a file chosen in the save window and check the file on
  // disk really has all of it. A file another program has open is often
  // released a moment later, so retry a few times before giving up.
  async function writeToFile(handle, bytes) {
    let lastError = null;
    for (const wait of [0, 500, 1000, 2000]) {
      if (wait) {
        setStatus(`Saving… (waiting for ${handle.name} to become available)`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      try {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        const written = await handle.getFile();
        if (written.size !== bytes.length) throw new Error(`only ${written.size} of ${bytes.length} bytes were written`);
        return;
      } catch (err) {
        lastError = err;
        if (err.name === 'NotAllowedError') break; // permission withdrawn: retrying won't help
      }
    }
    throw lastError;
  }

  function capitalize(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : text;
  }

  // The "Not saved" warning. Resolves true if the person picks the retry button.
  function notSaved(message, { retry = null } = {}) {
    return askConfirm(message, { title: '⚠ Not saved', yes: retry, no: 'OK', danger: false, warning: true });
  }

  // Print the edited PDF itself (not the editor screen) using the browser's
  // PDF viewer in a hidden frame.
  async function printPdf() {
    if (!state.order.length || state.busy) return;
    finishEditing();
    state.busy = true;
    state.busyLabel = 'preparing to print';
    updateButtons();
    setStatus('Preparing to print…');
    try {
      const url = URL.createObjectURL(new Blob([await buildPdf()], { type: 'application/pdf' }));
      const frame = document.createElement('iframe');
      frame.className = 'print-frame';
      frame.title = 'Print preview';
      frame.src = url;
      frame.addEventListener('load', () => {
        setTimeout(() => {
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch {
            window.open(url); // the browser blocks printing from the frame: open the PDF to print it there
          }
          setStatus('Print dialog opened.');
        }, 250);
      }, { once: true });
      document.body.append(frame);
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 10 * 60 * 1000);
    } catch (err) {
      console.error(err);
      setStatus(`Couldn't print: ${err.message || err}`);
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  function outputName() {
    const first = state.sources[0];
    const base = (first?.name || 'document.pdf').replace(/\.[^.]+$/, '');
    if (state.sources.length > 1) return `${base}-merged.pdf`;
    // A freshly converted photo or Word file just becomes "name.pdf".
    return first?.converted && state.undo.length === 0 ? `${base}.pdf` : `${base}-edited.pdf`;
  }

  function download(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ------------------------------------------------------------- wiring

  ui.fileInput.addEventListener('change', () => {
    openFiles(ui.fileInput.files, false);
    ui.fileInput.value = '';
  });
  ui.addInput.addEventListener('change', () => {
    openFiles(ui.addInput.files, true);
    ui.addInput.value = '';
  });
  ui.saveBtn.addEventListener('click', (e) => save({ saveAs: e.shiftKey }));
  ui.ocrBtn.addEventListener('click', runOcr);
  ui.undoBtn.addEventListener('click', undo);
  ui.redoBtn.addEventListener('click', redo);
  ui.deleteBtn.addEventListener('click', deleteSelected);
  ui.zoomIn.addEventListener('click', () => zoomStep(1));
  ui.zoomOut.addEventListener('click', () => zoomStep(-1));
  ui.zoomFit.addEventListener('click', zoomFit);

  // ----------------------------------------------------------- merge window

  // Lists the files to combine, in order, before anything is opened: drag
  // files in (or browse), drag rows (or use ↑ ↓) to reorder, × to remove.
  const merge = {
    dialog: $('#merge-dialog'),
    title: $('#merge-title'),
    list: $('#merge-list'),
    drop: $('#merge-drop'),
    input: $('#merge-input'),
    browse: $('#merge-browse'),
    note: $('#merge-note'),
    progress: $('#merge-progress'),
    cancel: $('#merge-cancel'),
    done: $('#merge-done'),
    items: [],
    dragIndex: null,
    busy: false,
  };

  const KIND_LABEL = { image: 'Photo', docx: 'Word document' };

  function openMergeDialog(files = [], { includeCurrent = state.order.length > 0 } = {}) {
    if (state.busy) {
      alert('Please wait for the current task to finish.');
      return;
    }
    if (merge.dialog.open) {
      addMergeFiles(files);
      return;
    }
    merge.items = [];
    merge.note.textContent = '';
    merge.progress.hidden = true;
    if (includeCurrent && state.order.length) {
      const n = state.order.length;
      merge.items.push({
        current: true,
        name: state.saveHandle?.name || state.sources[0]?.name || 'This document',
        meta: `Open now · ${n} page${n === 1 ? '' : 's'}`,
        thumb: currentDocThumb(),
      });
    }
    renderMergeList();
    merge.dialog.showModal();
    merge.browse.focus();
    addMergeFiles(files);
  }

  // A small picture of the open document's first page, from its canvas.
  function currentDocThumb() {
    const page = state.pageById.get(state.order[0]);
    const src = page?.canvas;
    if (!src?.width) return null;
    const c = document.createElement('canvas');
    const s = 96 / Math.max(src.width, src.height);
    c.width = Math.max(1, Math.round(src.width * s));
    c.height = Math.max(1, Math.round(src.height * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL();
  }

  function sameFile(a, b) {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  }

  function addMergeFiles(fileList) {
    const entries = [...fileList].map((x) => (x instanceof Blob ? { file: x, handle: null } : x));
    const notes = [];
    for (const entry of entries) {
      const kind = kindOf(entry.file);
      if (!kind || kind === 'doc') {
        notes.push(kind === 'doc'
          ? `${entry.file.name}: old .doc files can't be converted. Save it as .docx in Word first.`
          : `${entry.file.name}: not a PDF, photo or Word file.`);
        continue;
      }
      const item = {
        ...entry,
        kind,
        name: entry.file.name,
        meta: 'Reading…',
        loading: true,
      };
      merge.items.push(item);
      describeMergeItem(item);
    }
    if (notes.length) merge.note.textContent = notes.join(' ');
    renderMergeList();
  }

  // Fill in an item's picture and page count. PDFs are read here so a
  // password can be asked for now, not halfway through merging.
  async function describeMergeItem(item) {
    const size = item.file.size < 1048576
      ? `${Math.max(1, Math.round(item.file.size / 1024))} KB`
      : `${(item.file.size / 1048576).toFixed(1)} MB`;
    try {
      if (item.kind === 'pdf') {
        const pdfjs = await loadPdfjs();
        const task = pdfjs.getDocument({ data: new Uint8Array(await item.file.arrayBuffer()), isEvalSupported: false });
        let cancelled = false;
        task.onPassword = (provide, reason) => {
          const again = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
          const pw = prompt(again ? `Wrong password for ${item.name}. Try again:` : `${item.name} is password protected. Password:`);
          if (pw == null) {
            cancelled = true;
            task.destroy();
          } else {
            item.password = pw;
            provide(pw);
          }
        };
        let doc;
        try {
          doc = await task.promise;
        } catch (err) {
          if (cancelled) {
            removeMergeItem(item, `${item.name} was left out: it needs its password.`);
            return;
          }
          throw err;
        }
        try {
          item.pages = doc.numPages;
          item.meta = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'} · ${size}${item.password ? ' · 🔒' : ''}`;
          const page = await doc.getPage(1);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 96 / Math.max(vp1.width, vp1.height) });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width);
          c.height = Math.ceil(vp.height);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          item.thumb = c.toDataURL();
        } finally {
          doc.destroy();
        }
      } else if (item.kind === 'image') {
        item.meta = `Photo · ${size}`;
        item.thumb = URL.createObjectURL(item.file); // HEIC can't be shown: the row falls back to an icon
        item.objectUrl = item.thumb;
      } else {
        item.meta = `Word document · ${size}`;
      }
    } catch (err) {
      console.warn('Could not read', item.name, err);
      removeMergeItem(item, `${item.name} could not be read (${err.message || err}).`);
      return;
    }
    item.loading = false;
    renderMergeList();
  }

  function removeMergeItem(item, note = '') {
    const i = merge.items.indexOf(item);
    if (i < 0) return;
    merge.items.splice(i, 1);
    if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    if (note) merge.note.textContent = note;
    renderMergeList();
  }

  function moveMergeItem(from, to) {
    if (to < 0 || to >= merge.items.length || from === to) return;
    const [item] = merge.items.splice(from, 1);
    merge.items.splice(to, 0, item);
    renderMergeList();
  }

  function mergeIcon(kind) {
    const color = kind === 'docx' ? '#2563eb' : kind === 'image' ? '#0f766e' : '#b91c1c';
    const label = kind === 'docx' ? 'W' : kind === 'image' ? 'IMG' : 'PDF';
    return `<svg viewBox="0 0 40 48" aria-hidden="true"><path d="M4 2h22l10 10v34H4z" fill="#fff" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<text x="20" y="34" text-anchor="middle" font-size="${label.length > 1 ? 10 : 16}" font-family="sans-serif" font-weight="700" fill="${color}">${label}</text></svg>`;
  }

  function renderMergeList() {
    const focusedRow = document.activeElement?.closest?.('.merge-item');
    const focusKey = focusedRow ? [focusedRow.dataset.index, document.activeElement.dataset.act] : null;
    merge.list.textContent = '';
    // A file listed twice gets a note on its later copy (it is still allowed).
    merge.items.forEach((item, i) => {
      item.duplicate = !!item.file && merge.items.slice(0, i).some((x) => x.file && sameFile(x.file, item.file));
    });
    merge.items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'merge-item';
      li.dataset.index = i;
      li.draggable = !merge.busy;
      li.classList.toggle('current', !!item.current);
      li.classList.toggle('loading', !!item.loading);

      const grip = document.createElement('span');
      grip.className = 'merge-grip';
      grip.textContent = '⠿';
      grip.title = 'Drag to move';

      const num = document.createElement('span');
      num.className = 'merge-num';
      num.textContent = `${i + 1}.`;

      const pic = document.createElement('span');
      pic.className = 'merge-thumb';
      if (item.thumb) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = item.thumb;
        img.onerror = () => { pic.innerHTML = mergeIcon(item.kind); };
        pic.append(img);
      } else {
        pic.innerHTML = mergeIcon(item.kind || 'pdf');
      }

      const text = document.createElement('span');
      text.className = 'merge-text';
      const name = document.createElement('strong');
      name.textContent = item.name;
      name.title = item.name;
      const meta = document.createElement('span');
      meta.className = 'merge-meta';
      meta.textContent = item.meta || KIND_LABEL[item.kind] || '';
      text.append(name, meta);
      if (item.duplicate) {
        const dup = document.createElement('span');
        dup.className = 'merge-dup';
        dup.textContent = 'Already in the list. It will be added twice.';
        text.append(dup);
      }

      const buttons = document.createElement('span');
      buttons.className = 'merge-buttons';
      const button = (act, label, title, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn';
        b.dataset.act = act;
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-label', `${title}: ${item.name}`);
        b.disabled = disabled || merge.busy;
        buttons.append(b);
      };
      button('up', '↑', 'Move up', i === 0);
      button('down', '↓', 'Move down', i === merge.items.length - 1);
      if (item.current) {
        const keep = document.createElement('span');
        keep.className = 'merge-keep';
        buttons.append(keep);
      } else {
        button('remove', '×', 'Remove from the list');
      }

      li.append(grip, num, pic, text, buttons);
      merge.list.append(li);
    });
    if (focusKey) {
      // Keep the keyboard focus on the moved row's button.
      const btn = merge.list.querySelector(`.merge-item[data-index="${focusKey[0]}"] [data-act="${focusKey[1]}"]`);
      if (btn && !btn.disabled) btn.focus();
    }
    const n = merge.items.length;
    const loading = merge.items.some((x) => x.loading);
    merge.list.hidden = n === 0;
    merge.dialog.classList.toggle('has-files', n > 0);
    merge.done.textContent = n >= 2 ? `Merge ${n} files` : 'Merge files';
    merge.done.disabled = merge.busy || n < 2 || loading;
    merge.done.title = n < 2 ? 'Add at least two files' : loading ? 'Still reading the files…' : '';
    merge.browse.disabled = merge.busy;
  }

  merge.list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || merge.busy) return;
    const i = Number(btn.closest('.merge-item').dataset.index);
    if (btn.dataset.act === 'up') moveMergeItem(i, i - 1);
    else if (btn.dataset.act === 'down') moveMergeItem(i, i + 1);
    else if (btn.dataset.act === 'remove') {
      const item = merge.items[i];
      removeMergeItem(item);
      const rows = merge.list.querySelectorAll('.merge-item');
      (rows[Math.min(i, rows.length - 1)]?.querySelector('[data-act="remove"]') || merge.browse).focus();
    }
  });

  // Reordering by dragging rows.
  merge.list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('.merge-item');
    if (!li || merge.busy) return;
    merge.dragIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.index);
  });
  merge.list.addEventListener('dragend', () => {
    merge.dragIndex = null;
    merge.list.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  });

  // Where a dragged row (or dropped files) would go: before row i.
  function mergeDropIndex(e) {
    const rows = [...merge.list.querySelectorAll('.merge-item')];
    for (const [i, row] of rows.entries()) {
      const r = row.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  function showMergeDropMark(index) {
    const rows = [...merge.list.querySelectorAll('.merge-item')];
    rows.forEach((row) => row.classList.remove('drop-before', 'drop-after'));
    if (index < rows.length) rows[index].classList.add('drop-before');
    else rows[rows.length - 1]?.classList.add('drop-after');
  }

  const draggingFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  // The whole window takes the drop, so files dropped a little off target
  // aren't opened by the browser instead.
  merge.dialog.addEventListener('dragover', (e) => {
    if (merge.busy) return;
    if (merge.dragIndex != null) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showMergeDropMark(mergeDropIndex(e));
    } else if (draggingFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      merge.dialog.classList.add('dragover');
      if (e.target.closest?.('.merge-list')) showMergeDropMark(mergeDropIndex(e));
      else merge.list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    }
  });
  merge.dialog.addEventListener('dragleave', (e) => {
    if (!merge.dialog.contains(e.relatedTarget)) {
      merge.dialog.classList.remove('dragover');
      merge.list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    }
  });
  merge.dialog.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    merge.dialog.classList.remove('dragover');
    if (merge.busy) return;
    const at = mergeDropIndex(e);
    const onList = !!e.target.closest?.('.merge-list');
    merge.list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    if (merge.dragIndex != null) {
      const from = merge.dragIndex;
      merge.dragIndex = null;
      moveMergeItem(from, at > from ? at - 1 : at);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const items = [...e.dataTransfer.items].filter((item) => item.kind === 'file');
    const handles = items.map((item) => (item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : null));
    Promise.all(handles).then((list) => {
      const before = merge.items.length;
      addMergeFiles(files.map((file, i) => ({ file, handle: list[i]?.kind === 'file' ? list[i] : null })));
      // Dropped onto the list: put them where they were dropped.
      if (onList && at < before) {
        const added = merge.items.splice(before);
        merge.items.splice(at, 0, ...added);
        renderMergeList();
      }
    });
  });

  // Keyboard: Alt+↑ / Alt+↓ moves the focused row.
  merge.list.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const li = e.target.closest('.merge-item');
    if (!li) return;
    e.preventDefault();
    const i = Number(li.dataset.index);
    moveMergeItem(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
  });

  merge.browse.addEventListener('click', async () => {
    if (!canPickOpenFile) {
      merge.input.click();
      return;
    }
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: 'PDFs, photos and Word files',
          accept: {
            'application/pdf': ['.pdf'],
            'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif'],
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
          },
        }],
      });
      addMergeFiles(await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle }))));
    } catch (err) {
      if (err.name !== 'AbortError') merge.input.click();
    }
  });
  merge.input.addEventListener('change', () => {
    addMergeFiles([...merge.input.files]);
    merge.input.value = '';
  });

  async function cancelMerge() {
    if (merge.busy) return;
    if (merge.items.some((x) => !x.current)) {
      const sure = await askConfirm('The files you added won\'t be merged.', {
        title: 'Cancel merging?', yes: 'Discard files', no: 'Keep adding', danger: false,
      });
      if (!sure) return;
    }
    closeMergeDialog();
  }

  function closeMergeDialog() {
    for (const x of merge.items) if (x.objectUrl) URL.revokeObjectURL(x.objectUrl);
    merge.items = [];
    merge.busy = false;
    merge.dialog.close();
  }

  merge.cancel.addEventListener('click', cancelMerge);
  merge.dialog.addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc asks first, like Cancel
    cancelMerge();
  });

  merge.done.addEventListener('click', finishMerge);

  async function finishMerge() {
    if (merge.busy || merge.items.length < 2 || merge.items.some((x) => x.loading)) return;
    const items = merge.items.slice();
    const hasCurrent = items.some((x) => x.current);
    const newItems = items.filter((x) => !x.current);
    if (!hasCurrent && state.dirty) {
      const sure = await askConfirm('The open document has changes that aren\'t saved. Merging starts a new document.', {
        title: 'Unsaved changes', yes: 'Merge anyway', no: 'Go back', danger: false,
      });
      if (!sure) return;
      state.dirty = false; // already asked
    }
    merge.busy = true;
    merge.progress.hidden = false;
    const bar = merge.progress.querySelector('progress');
    const label = merge.progress.querySelector('span');
    bar.max = newItems.length;
    bar.value = 0;
    renderMergeList();
    const onFile = (i, n, name) => {
      bar.value = i;
      label.textContent = `Adding file ${i + 1} of ${n}: ${name}`;
    };
    const entries = newItems.map(({ file, handle, password }) => ({ file, handle, password }));
    const currentOrder = state.order.slice();
    let results;
    try {
      results = hasCurrent
        ? await openFiles(entries, true, { onFile })
        : await openFiles(entries, false, { merged: true, onFile });
    } finally {
      bar.value = newItems.length;
    }
    // Put the open document's pages where it was placed in the list.
    if (hasCurrent && results.some((r) => r != null)) {
      const pagesOf = new Map();
      for (const id of state.order) {
        const src = state.pageById.get(id).src;
        if (!pagesOf.has(src)) pagesOf.set(src, []);
        pagesOf.get(src).push(id);
      }
      const order = [];
      let k = 0;
      for (const item of items) {
        if (item.current) order.push(...currentOrder);
        else {
          const src = results[k++];
          if (src != null) order.push(...(pagesOf.get(src) || []));
        }
      }
      if (order.length === state.order.length) {
        state.order = order;
        layoutPages();
        if (panel.open) renderPanel();
      }
    }
    const added = results.filter((r) => r != null).length;
    closeMergeDialog();
    if (added) {
      const n = state.order.length;
      setStatus(`Merged ${added + (hasCurrent ? 1 : 0)} files: ${n} page${n === 1 ? '' : 's'}. ` +
        (state.saveHandle ? `Ctrl+S saves to ${state.saveHandle.name}.` : 'Ctrl+S asks where to save the merged PDF.'));
    }
  }

  // ------------------------------------------------- start screen and Close

  $('#start-open').addEventListener('click', () => chooseFiles(false));
  $('#start-merge').addEventListener('click', () => openMergeDialog([], { includeCurrent: false }));

  async function closeDocument() {
    if (!state.order.length || state.busy) return;
    finishEditing();
    if (state.dirty) {
      const sure = await askConfirm('Your changes haven\'t been saved.', {
        title: 'Close document?', yes: 'Close without saving', no: 'Keep editing',
      });
      if (!sure) return;
    }
    if (panel.open) togglePanel(false);
    resetDocument();
    setStatus('No document open.');
    ui.viewer.scrollTop = 0;
  }

  ui.closeBtn.addEventListener('click', closeDocument);

  // Dropping files: one file onto the start screen opens it; otherwise the
  // merge window opens with them.
  ui.viewer.addEventListener('dragover', (e) => {
    if (panel.dragId) return; // a page being reordered in the page viewer
    e.preventDefault();
    ui.viewer.classList.add('dragover');
  });
  ui.viewer.addEventListener('dragleave', () => ui.viewer.classList.remove('dragover'));
  ui.viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.viewer.classList.remove('dragover');
    const files = [...e.dataTransfer.files];
    // Ask for handles to the dropped files right away (only possible during
    // the drop event), so a dropped PDF can be saved back into too.
    const items = [...e.dataTransfer.items].filter((item) => item.kind === 'file');
    const handles = items.map((item) => (item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : null));
    Promise.all(handles).then((list) => {
      const entries = files.map((file, i) => ({ file, handle: list[i]?.kind === 'file' ? list[i] : null }));
      if (!entries.length) return;
      // One file onto the start screen opens it; otherwise the merge window
      // opens so the order can be checked first.
      if (!state.order.length && entries.length === 1) openFiles(entries, false);
      else openMergeDialog(entries);
    });
  });

  const TOOL_KEYS = { v: 'select', t: 'text', h: 'highlight', w: 'whiteout', r: 'rect', d: 'draw' };

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey; // Ctrl on Windows, ⌘ on Mac
    const key = e.key.toLowerCase();

    // Save / Save As / Open / Print work everywhere, even while typing in a
    // text box, and never fall through to the browser's own versions.
    if (mod && !e.altKey && (key === 's' || key === 'o' || key === 'p')) {
      e.preventDefault();
      if (document.querySelector('dialog[open]')) return;
      if (key === 's') save({ saveAs: e.shiftKey }); // explains itself if it can't save now
      else if (state.busy) return;
      else if (key === 'o') chooseFiles(false);
      else printPdf();
      return;
    }
    if (state.editingId != null) return;
    if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys

    const inField = e.target.matches('input, select, textarea, [contenteditable]');
    // Fields you type into keep their own Ctrl+Z (undo typing); anywhere
    // else — including check boxes, color pickers and drop-downs — Ctrl+Z
    // undoes the last change to the document.
    const typingField = e.target.matches('textarea, [contenteditable], ' +
      'input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="range"]):not([type="file"]):not([type="button"]):not([type="submit"])');
    const selected = getAnnot(state.selectedId);

    if (mod && !e.altKey && (key === 'z' || key === 'y') && !typingField) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo();
      else undo();
    } else if (inField) {
      return;
    } else if (mod && (key === '=' || key === '+')) {
      e.preventDefault();
      zoomStep(1);
    } else if (mod && (key === '-' || key === '_')) {
      e.preventDefault();
      zoomStep(-1);
    } else if (mod && key === '0') {
      e.preventDefault();
      setZoom(1);
    } else if (mod && key === 'a') {
      // Select all the document's text (not the toolbar's).
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(ui.pages);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (mod && key === 'd' && selected) {
      e.preventDefault();
      pasteAnnot(JSON.parse(JSON.stringify(selected)), selected.page);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Enter' && selected?.type === 'text') {
      e.preventDefault();
      startEditing(selected.id);
    } else if (e.key.startsWith('Arrow') && selected && !mod) {
      e.preventDefault();
      nudgeSelected(e.key, e.shiftKey ? 10 : 1);
    } else if (e.key === 'Escape' && panel.open) {
      togglePanel(false);
    } else if (e.key === 'Escape') {
      window.getSelection()?.removeAllRanges();
      select(null);
      setTool('select');
    } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
    } else if (!mod && scrollViewerForKey(e)) {
      e.preventDefault();
    }
  });

  // Page Up/Down, Space, Home/End and the arrow keys scroll the document
  // (focus usually sits on the page itself, which doesn't scroll).
  function scrollViewerForKey(e) {
    if (!state.order.length) return false;
    if (e.target !== document.body && !ui.viewer.contains(e.target)) return false; // e.g. Space on a button
    const v = ui.viewer;
    const page = v.clientHeight * 0.9;
    const moves = {
      ArrowDown: [0, 40], ArrowUp: [0, -40], ArrowRight: [40, 0], ArrowLeft: [-40, 0],
      PageDown: [0, page], PageUp: [0, -page], ' ': [0, e.shiftKey ? -page : page],
    };
    if (e.key === 'Home') v.scrollTo({ top: 0 });
    else if (e.key === 'End') v.scrollTo({ top: v.scrollHeight });
    else if (moves[e.key]) v.scrollBy(moves[e.key][0], moves[e.key][1]);
    else return false;
    return true;
  }

  // Arrow keys move the selected item; a burst of presses is one undo step.
  let lastNudge = { id: null, time: 0 };
  function nudgeSelected(key, step) {
    const items = selectedItems();
    const a = items[0];
    if (!a) return;
    const now = Date.now();
    if (lastNudge.id !== a.id || now - lastNudge.time > 1000) checkpoint();
    lastNudge = { id: a.id, time: now };
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    for (const x of items) {
      moveAnnot(x, JSON.parse(JSON.stringify(x)), dx, dy);
      refreshAnnot(x);
    }
  }

  // --- copy, cut and paste of added items (Ctrl+C / Ctrl+X / Ctrl+V)
  //
  // Selected text copies as usual. With an item selected (and no text
  // selected), the item itself is copied. Pasting plain text from elsewhere
  // creates a text box.

  const CLIP_TYPE = 'application/x-pdf-editor-item';
  let clipboardItem = null;

  function textIsSelected() {
    const sel = window.getSelection();
    return sel && !sel.isCollapsed;
  }

  function copySelectedItem(e) {
    const a = getAnnot(state.selectedId);
    if (!a || state.editingId != null || textIsSelected() || e.target.matches?.('input, textarea, [contenteditable]')) return false;
    clipboardItem = JSON.parse(JSON.stringify(a));
    e.preventDefault();
    e.clipboardData.setData(CLIP_TYPE, JSON.stringify(clipboardItem));
    e.clipboardData.setData('text/plain', a.type === 'text' ? a.text : '');
    return true;
  }

  document.addEventListener('copy', (e) => {
    if (copySelectedItem(e)) setStatus('Copied. Press Ctrl+V to paste.');
  });
  document.addEventListener('cut', (e) => {
    if (copySelectedItem(e)) {
      deleteSelected();
      setStatus('Cut. Press Ctrl+V to paste.');
    }
  });
  document.addEventListener('paste', (e) => {
    if (!state.order.length || state.editingId != null || document.querySelector('dialog[open]')) return;
    if (e.target.matches?.('input, textarea, [contenteditable]')) return;
    const data = e.clipboardData;
    let item = null;
    try {
      item = data.getData(CLIP_TYPE) ? JSON.parse(data.getData(CLIP_TYPE)) : null;
    } catch {
      item = null;
    }
    const text = data.getData('text/plain');
    if (!item && clipboardItem && (text === (clipboardItem.text || '') || !text)) item = clipboardItem;
    if (item) {
      e.preventDefault();
      pasteAnnot(item, visiblePage().id);
    } else if (text.trim()) {
      e.preventDefault();
      const page = visiblePage();
      const r = page.el.getBoundingClientRect();
      const vr = ui.viewer.getBoundingClientRect();
      const y = Math.max(20, (Math.max(r.top, vr.top) - r.top) / state.zoom + 40);
      const a = addAnnot({ page: page.id, type: 'text', text: text.replace(/\r\n?/g, '\n'), x: 40, y, size: state.fontSize, color: state.colors.text });
      select(a.id);
      setStatus('Pasted text as a text box. Drag it where you want it.');
    }
  });

  // The page filling most of the view.
  function visiblePage() {
    const vr = ui.viewer.getBoundingClientRect();
    let best = pages()[0];
    let bestArea = -1;
    for (const p of pages()) {
      const r = p.el.getBoundingClientRect();
      const h = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
      if (h > bestArea) {
        best = p;
        bestArea = h;
      }
    }
    return best;
  }

  // Add a copy of an item to a page, a little offset so it's easy to see.
  function pasteAnnot(item, pageId) {
    const page = state.pageById.get(pageId) || visiblePage();
    const copy = JSON.parse(JSON.stringify(item));
    delete copy.id;
    delete copy.isNew;
    delete copy.group;
    const offset = 12;
    moveAnnot(copy, JSON.parse(JSON.stringify(copy)), offset, offset);
    copy.page = page.id;
    const a = addAnnot(copy);
    select(a.id);
    setStatus('Pasted.');
  }

  // Ctrl + mouse wheel (or a trackpad pinch) zooms the document.
  let wheelZoom = null;
  ui.viewer.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !state.order.length) return;
    e.preventDefault();
    wheelZoom = (wheelZoom ?? state.zoom) * Math.exp(-e.deltaY * 0.0025);
    requestAnimationFrame(() => {
      if (wheelZoom != null) setZoom(wheelZoom);
      wheelZoom = null;
    });
  }, { passive: false });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // When the installed app is used to open files from Explorer / Finder
  // ("Open with"), the browser hands them over here.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const items = await Promise.all(params.files.map(async (handle) => ({ file: await handle.getFile(), handle })));
      if (items.length > 1) openMergeDialog(items, { includeCurrent: false });
      else openFiles(items, false);
    });
  }

  // Exposed for automated tests / debugging in the console.
  window.pdfEditor = { state, panel, textIndex, openFiles, save, printPdf, buildPdf, runOcr, setTool, setZoom, movePage, deletePage, deletePages, rotatePages, togglePanel, openMergeDialog, closeDocument, merge };

  showColor(state.colors[state.tool]);
  updateHighlightPreview();
  updateButtons();
  if (typeof PDFLib === 'undefined') {
    setStatus('Could not load the PDF libraries. Check your internet connection and reload.');
  }
})();
