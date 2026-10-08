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
    '#000000', '#5f6368', '#9aa0a6', '#ffffff',
    '#e53935', '#fb8c00', '#ffeb3b', '#c6ff00',
    '#43a047', '#00bfa5', '#00b0ff', '#1e88e5',
    '#3949ab', '#8e24aa', '#ff4081', '#6d4c41',
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

  const { kindOf, toPdf: convertToPdf, makeSanitizer, writeInvisibleText } = window.PdfConvert;

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

  function checkpoint() {
    state.undo.push(snapshot());
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
    state.dirty = true;
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
    state.dirty = true;
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
    ui.ocrBtn.disabled = !hasDoc || state.busy;
    ui.undoBtn.disabled = !state.undo.length;
    ui.redoBtn.disabled = !state.redo.length;
    ui.deleteBtn.disabled = state.selectedId == null;
    ui.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  // -------------------------------------------------------------- loading

  // Open replaces the current document; append (merge) adds pages to the end.
  async function openFiles(fileList, append = false) {
    const all = [...fileList];
    const files = all.filter((f) => kindOf(f));
    const skipped = all.filter((f) => !kindOf(f));
    if (skipped.length) {
      alert(`These files can't be opened: ${skipped.map((f) => f.name).join(', ')}\n\n` +
        'Supported: PDF, photos (JPG, PNG, iPhone HEIC…) and Word .docx files.');
    }
    if (!files.length) return;
    if (state.busy) {
      alert('Please wait for the current task to finish.');
      return;
    }
    append = append && state.order.length > 0;
    if (!append) {
      if (state.dirty && !confirm('You have unsaved changes. Open another file anyway?')) return;
      resetDocument();
    }
    const token = state.loadToken;
    const before = append ? snapshot() : null;
    let added = 0;
    state.busy = true;
    updateButtons();
    try {
      for (const file of files) {
        const n = await addSource(file, token);
        if (token !== state.loadToken) return;
        added += n;
      }
    } finally {
      state.busy = false;
      updateButtons();
    }
    if (append && added) {
      state.undo.push(before);
      state.redo = [];
      state.dirty = true;
    } else if (files.length > 1) {
      state.dirty = true;
    }
    const first = state.sources[0];
    document.title = `${first ? first.name : 'PDF'} — PDF Editor`;
    const n = state.order.length;
    const merged = state.sources.length > 1 ? ` (merged from ${state.sources.length} files)` : '';
    setStatus(`${n} page${n === 1 ? '' : 's'}${merged}.` +
      (append && added ? ` Added ${added} page${added === 1 ? '' : 's'} at the end.` : ''));
    updateButtons();
  }

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
      textReady: Promise.resolve(),
    });
    updateButtons();
  }

  async function addSource(file, token) {
    try {
      const pdfjs = await loadPdfjs();
      const kind = kindOf(file);
      let bytes;
      if (kind === 'pdf') {
        setStatus(`Opening ${file.name}…`);
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        setStatus(`Converting ${file.name} to PDF…`);
        setProgress(0);
        try {
          bytes = await convertToPdf(file, (f) => setProgress(f));
        } finally {
          setProgress(null);
        }
      }
      const task = pdfjs.getDocument({
        data: bytes.slice(),
        isEvalSupported: false,
        // Needed for some Asian-language PDFs and PDFs that don't embed their fonts.
        cMapUrl: CDN.pdfjsCmaps,
        cMapPacked: true,
        standardFontDataUrl: CDN.pdfjsFonts,
      });
      task.onPassword = (provide, reason) => {
        const again = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
        const pw = prompt(again ? `Wrong password for ${file.name}. Try again:` : `${file.name} is password protected. Password:`);
        if (pw == null) task.destroy();
        else provide(pw);
      };
      const doc = await task.promise;
      if (token !== state.loadToken) {
        doc.destroy();
        return 0;
      }
      const src = state.sources.length;
      state.sources.push({ name: file.name || 'document.pdf', bytes, doc, converted: kind !== 'pdf' });

      const newPages = [];
      for (let i = 0; i < doc.numPages; i++) {
        const pdfPage = await doc.getPage(i + 1);
        if (token !== state.loadToken) return 0;
        const page = createPage(src, i, pdfPage);
        state.order.push(page.id);
        newPages.push(page);
      }
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
  function turnPageContent(page, quarters) {
    const W = page.vp.width;
    const H = page.vp.height;
    const deg = quarters * 90;
    for (const a of state.annots) {
      if (a.page !== page.id) continue;
      if (a.type === 'ink') {
        a.points = a.points.map(([x, y]) => turnPoint(x, y, W, H, quarters));
      } else if (a.type === 'text') {
        [a.x, a.y] = turnPoint(a.x, a.y, W, H, quarters);
        a.rot = ((a.rot || 0) + deg) % 360;
      } else {
        const [x1, y1] = turnPoint(a.x, a.y, W, H, quarters);
        const [x2, y2] = turnPoint(a.x + a.w, a.y + a.h, W, H, quarters);
        Object.assign(a, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
      }
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

  const THUMB_WIDTH = 150;

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
    const scale = THUMB_WIDTH / page.vp.width;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${THUMB_WIDTH}px`;
    canvas.style.height = `${Math.round(page.vp.height * scale)}px`;
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
    frame.append(canvas, check, turns);
    const num = document.createElement('div');
    num.className = 'thumb-num';
    item.append(frame, num);
    entry = { item, frame, canvas, checkbox, num, rendered: false };
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
    message: $('#confirm-message'),
    yes: $('#confirm-yes'),
    no: $('#confirm-no'),
  };

  // Ask a yes/no question. Resolves true for Yes, false for No or Esc.
  function askConfirm(message) {
    return new Promise((resolve) => {
      confirmUi.message.textContent = message;
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
    if (a.id === state.selectedId) el.classList.add('selected');
    return el;
  }

  function annotEl(id) {
    return ui.pages.querySelector(`.annot[data-id="${id}"]`);
  }

  // Re-render one annotation after a property change. A text box being typed
  // in is styled in place so the caret isn't lost.
  function refreshAnnot(a) {
    const el = annotEl(a.id);
    if (!el) return;
    if (a.id === state.editingId) {
      el.style.color = a.color;
      el.style.fontSize = `${a.size * state.zoom}px`;
    } else {
      el.replaceWith(createAnnotEl(a));
    }
  }

  function select(id) {
    if (state.selectedId === id) return;
    if (state.selectedId != null) annotEl(state.selectedId)?.classList.remove('selected');
    state.selectedId = id;
    if (id != null) {
      annotEl(id)?.classList.add('selected');
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
  }

  function deleteSelected() {
    const a = getAnnot(state.selectedId);
    if (!a) return;
    if (state.editingId === a.id) state.editingId = null;
    checkpoint();
    state.annots = state.annots.filter((x) => x !== a);
    state.selectedId = null;
    redrawPageOf(a);
    updateButtons();
  }

  function addAnnot(a) {
    checkpoint();
    a.id = state.nextId++;
    state.annots.push(a);
    redrawPageOf(a);
    return a;
  }

  // -------------------------------------------------------- text editing

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
      e.stopPropagation();
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
  }

  // -------------------------------------------------------- pointer input

  const DRAG_RECT_TOOLS = new Set(['highlight', 'whiteout', 'rect']);

  function attachPageEvents(page) {
    const layer = page.annotLayer;
    let drag = null;

    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const target = e.target.closest('.annot');
      const id = target ? Number(target.dataset.id) : null;
      if (id != null && id === state.editingId) return; // clicks inside the box being edited
      const pt = pointInPage(page, e);
      const tool = state.tool;

      if (tool === 'select') {
        if (id == null) return;
        e.preventDefault();
        finishEditing();
        select(id);
        const a = getAnnot(id);
        drag = { kind: 'move', a, start: pt, orig: JSON.stringify(a), moved: false };
      } else if (tool === 'text') {
        e.preventDefault();
        if (id != null && getAnnot(id)?.type === 'text') {
          startEditing(id);
          return;
        }
        finishEditing();
        const size = state.fontSize;
        const a = addAnnot({
          page: page.id, type: 'text', text: '',
          x: pt.x - TEXT_PADDING, y: pt.y - size * TEXT_LINE_HEIGHT / 2 - TEXT_PADDING,
          size, color: state.colors.text, isNew: true,
        });
        startEditing(a.id);
        return;
      } else if (DRAG_RECT_TOOLS.has(tool)) {
        e.preventDefault();
        finishEditing();
        select(null);
        const proto = { type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: state.colors[tool], width: state.lineWidth, fill: state.rectFill };
        const el = createAnnotEl(proto);
        el.classList.add('draft');
        if (tool === 'whiteout') el.style.outline = '1px dashed #999';
        layer.append(el);
        drag = { kind: 'rect', tool, start: pt, el, cur: pt };
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
        drag = { kind: 'ink', points: [[round(pt.x), round(pt.y)]], svg, line };
      }
      if (drag) layer.setPointerCapture(e.pointerId);
    });

    layer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pt = pointInPage(page, e);
      if (drag.kind === 'move') {
        const dx = pt.x - drag.start.x;
        const dy = pt.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) < 2 / state.zoom) return;
        if (!drag.moved) {
          drag.moved = true;
          checkpoint();
          drag.base = JSON.parse(drag.orig);
        }
        moveAnnot(drag.a, drag.base, dx, dy);
        refreshAnnot(drag.a);
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
      if (layer.hasPointerCapture(e.pointerId)) layer.releasePointerCapture(e.pointerId);
      if (d.kind === 'rect') {
        d.el.remove();
        const r = normRect(d.start, d.cur);
        if (r.w > 2 && r.h > 2) {
          const a = { page: page.id, type: d.tool, ...r, color: state.colors[d.tool] };
          if (d.tool === 'rect') Object.assign(a, { width: state.lineWidth, fill: state.rectFill });
          addAnnot(a);
        }
      } else if (d.kind === 'ink') {
        d.svg.remove();
        if (e.type !== 'pointercancel') {
          addAnnot({ page: page.id, type: 'ink', points: d.points, color: state.colors.draw, width: state.lineWidth });
        }
      }
    };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);

    // Stop the browser from moving focus / starting a text selection when we
    // handle the press ourselves (otherwise a new text box would lose focus).
    layer.addEventListener('mousedown', (e) => {
      const target = e.target.closest('.annot');
      if (target && Number(target.dataset.id) === state.editingId) return;
      if (state.tool !== 'select' || target) e.preventDefault();
    });

    // Double-click a text box to edit it. (The pointer is captured while
    // pressing, so the event's target is the layer; look at what's under it.)
    layer.addEventListener('dblclick', (e) => {
      if (state.tool !== 'select') return;
      const target = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('.annot.txt'));
      if (target) startEditing(Number(target.dataset.id));
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
    const pt = pointInPage(page, e);
    const hit = state.annots.filter((a) => a.page === page.id && (a.type === 'highlight' || a.type === 'rect') &&
      pt.x >= a.x && pt.x <= a.x + a.w && pt.y >= a.y && pt.y <= a.y + a.h).pop();
    if (hit) select(hit.id);
  });

  // ------------------------------------------------ highlight selected text

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
    const a = getAnnot(state.selectedId);
    if (a) {
      if (commit) checkpoint();
      a.color = color;
      state.colors[toolFor(a.type)] = color;
      refreshAnnot(a);
    }
    state.colors[state.tool] = color;
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
      state.dirty = true;
      const total = targets.reduce((n, p) => n + (state.ocr[p.id]?.length || 0), 0);
      setStatus(`OCR finished: found ${total} words on ${targets.length} page${targets.length === 1 ? '' : 's'}. ` +
        'Click Save to download a searchable PDF.');
    } catch (err) {
      console.error(err);
      if (done) {
        state.undo.push(before);
        state.dirty = true;
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

  async function loadForSaving(source) {
    try {
      return await PDFLib.PDFDocument.load(source.bytes);
    } catch (err) {
      if (/encrypt/i.test(err.message)) {
        throw new Error(`${source.name} is encrypted/protected, and saving changes to protected PDFs is not supported. ` +
          'Try "Print → Save as PDF" in your browser to make an unprotected copy first.');
      }
      throw err;
    }
  }

  // Build the output document with the pages in state.order. When the first
  // file's pages are still in their original order (some may be deleted) and
  // any other files' pages come after them, edit that file in place so its
  // bookmarks, metadata and form fields survive. Otherwise assemble a new PDF.
  async function assemblePages() {
    const L = PDFLib;
    const list = pages();
    const libDocs = new Map();
    const lib = async (src) => {
      if (!libDocs.has(src)) libDocs.set(src, await loadForSaving(state.sources[src]));
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

  async function save() {
    if (!state.order.length || state.busy) return;
    finishEditing();
    const L = PDFLib;
    state.busy = true;
    updateButtons();
    setStatus('Saving…');
    try {
      const out = await assemblePages();
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
        const rectToPdf = (a) => {
          const [x1, y1] = toPdf(a.x, a.y);
          const [x2, y2] = toPdf(a.x + a.w, a.y + a.h);
          return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
        };

        if (words.length) writeInvisibleText(target, font, clean, words, toPdf, rot);

        for (const a of annots) {
          if (a.type === 'highlight') {
            target.drawRectangle({ ...rectToPdf(a), color: hexToRgb(a.color), opacity: HIGHLIGHT_OPACITY, blendMode: L.BlendMode.Multiply });
          } else if (a.type === 'whiteout') {
            target.drawRectangle({ ...rectToPdf(a), color: hexToRgb(a.color) });
          } else if (a.type === 'rect') {
            // On screen the border is drawn inside the box; PDF strokes are
            // centered on the edge, so inset by half the line width.
            const r = rectToPdf(a);
            const half = Math.min(a.width / 2, r.width / 2, r.height / 2);
            const color = hexToRgb(a.color);
            target.drawRectangle({
              x: r.x + half, y: r.y + half, width: r.width - 2 * half, height: r.height - 2 * half,
              borderColor: color, borderWidth: a.width, color: a.fill ? color : undefined,
            });
          } else if (a.type === 'text') {
            // a.rot: how far the box is turned clockwise on screen (pages rotated after typing).
            const turn = ((a.rot || 0) * Math.PI) / 180;
            const lines = a.text.split('\n');
            lines.forEach((line, k) => {
              if (!line) return;
              const dx = TEXT_PADDING;
              const dy = TEXT_PADDING + a.size * TEXT_LINE_HEIGHT * k + a.size * BASELINE_RATIO;
              const bx = a.x + dx * Math.cos(turn) - dy * Math.sin(turn);
              const by = a.y + dx * Math.sin(turn) + dy * Math.cos(turn);
              const [x, y] = toPdf(bx, by);
              target.drawText(clean(line), { x, y, size: a.size, font, color: hexToRgb(a.color), rotate: L.degrees(rot - (a.rot || 0)) });
            });
          } else if (a.type === 'ink') {
            const color = hexToRgb(a.color);
            const pts = a.points.map(([x, y]) => toPdf(x, y));
            if (pts.length === 1) {
              target.drawCircle({ x: pts[0][0], y: pts[0][1], size: a.width / 2, color });
            }
            for (let k = 1; k < pts.length; k++) {
              target.drawLine({
                start: { x: pts[k - 1][0], y: pts[k - 1][1] },
                end: { x: pts[k][0], y: pts[k][1] },
                thickness: a.width, color, lineCap: L.LineCapStyle.Round,
              });
            }
          }
        }
      });

      const bytes = await out.save();
      const name = outputName();
      download(bytes, name);
      state.dirty = false;
      setStatus(`Saved ${name}.`);
    } catch (err) {
      console.error(err);
      setStatus(`Save failed: ${err.message || err}`);
      alert(`Save failed: ${err.message || err}`);
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
  ui.saveBtn.addEventListener('click', save);
  ui.ocrBtn.addEventListener('click', runOcr);
  ui.undoBtn.addEventListener('click', undo);
  ui.redoBtn.addEventListener('click', redo);
  ui.deleteBtn.addEventListener('click', deleteSelected);
  ui.zoomIn.addEventListener('click', () => zoomStep(1));
  ui.zoomOut.addEventListener('click', () => zoomStep(-1));
  ui.zoomFit.addEventListener('click', zoomFit);

  // Dropping files: opens them, or adds them to the end if a document is open.
  ui.viewer.addEventListener('dragover', (e) => {
    if (panel.dragId) return; // a page being reordered in the page viewer
    e.preventDefault();
    ui.viewer.classList.add('dragover');
  });
  ui.viewer.addEventListener('dragleave', () => ui.viewer.classList.remove('dragover'));
  ui.viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.viewer.classList.remove('dragover');
    openFiles(e.dataTransfer.files, true);
  });

  const TOOL_KEYS = { v: 'select', t: 'text', h: 'highlight', w: 'whiteout', r: 'rect', d: 'draw' };

  document.addEventListener('keydown', (e) => {
    if (state.editingId != null) return;
    if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys
    const inField = e.target.matches('input, select, textarea, [contenteditable]');
    // Fields you type into keep their own Ctrl+Z (undo typing); anywhere
    // else — including check boxes, color pickers and drop-downs — Ctrl+Z
    // undoes the last change to the document.
    const typingField = e.target.matches('textarea, [contenteditable], ' +
      'input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="range"]):not([type="file"]):not([type="button"]):not([type="submit"])');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      save();
    } else if (mod && key === 'o') {
      e.preventDefault();
      ui.fileInput.click();
    } else if (mod && !e.altKey && (key === 'z' || key === 'y') && !typingField) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo();
      else undo();
    } else if (inField) {
      return;
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId != null) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Escape' && panel.open) {
      togglePanel(false);
    } else if (e.key === 'Escape') {
      select(null);
      setTool('select');
    } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
    } else if (mod && (key === '=' || key === '+')) {
      e.preventDefault();
      zoomStep(1);
    } else if (mod && key === '-') {
      e.preventDefault();
      zoomStep(-1);
    }
  });

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
      const files = await Promise.all(params.files.map((handle) => handle.getFile()));
      openFiles(files, false);
    });
  }

  // Exposed for automated tests / debugging in the console.
  window.pdfEditor = { state, panel, openFiles, save, runOcr, setTool, setZoom, movePage, deletePage, deletePages, rotatePages, togglePanel };

  showColor(state.colors[state.tool]);
  updateButtons();
  if (typeof PDFLib === 'undefined') {
    setStatus('Could not load the PDF libraries. Check your internet connection and reload.');
  }
})();
