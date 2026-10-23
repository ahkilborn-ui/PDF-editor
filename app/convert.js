/* Converts photos (including iPhone HEIC) and Word .docx files into PDFs,
 * entirely in the browser, so they can be edited like any other PDF.
 *
 * Also holds the small PDF helpers shared with app.js for writing invisible,
 * searchable text.
 *
 * Exposes window.PdfConvert.
 */
(() => {
  'use strict';

  // See the note in app.js: CDN in the browser version, vendor/ in the offline app.
  const LIB_BASE = window.PDF_EDITOR_LIB_BASE || 'https://cdn.jsdelivr.net/npm/';
  const lib = (path) => new URL(LIB_BASE + path, document.baseURI).href;

  const CDN = {
    heicTo: lib('heic-to@1.5.2/dist/iife/heic-to.js'),
    jszip: lib('jszip@3.10.1/dist/jszip.min.js'),
    docxPreview: lib('docx-preview@0.4.0/dist/docx-preview.min.js'),
    html2canvas: lib('html2canvas@1.4.1/dist/html2canvas.min.js'),
    qpdfJs: lib('@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.js'),
    qpdfWasm: lib('@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm'),
  };

  const PX_TO_PT = 0.75;                 // CSS pixel (1/96 in) -> PDF point (1/72 in)
  const PHOTO_PAGE = [612, 792];         // US Letter, in points; turned sideways for wide photos
  const PHOTO_MARGIN = 18;               // 1/4 inch
  const PHOTO_MAX_SIDE = 4000;           // downscale huge photos to keep files reasonable
  const DOCX_RENDER_SCALE = 2;           // ~192 dpi page images

  // ------------------------------------------------------------- helpers

  const scripts = new Map();
  function loadScript(url) {
    if (!scripts.has(url)) {
      scripts.set(url, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => {
          scripts.delete(url);
          reject(new Error('could not download a conversion library (are you online?)'));
        };
        document.head.append(s);
      }));
    }
    return scripts.get(url);
  }

  function ext(name) {
    const m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /** 'pdf' | 'image' | 'docx' | 'doc' | null */
  function kindOf(file) {
    const e = ext(file.name);
    const t = (file.type || '').toLowerCase();
    if (t === 'application/pdf' || e === 'pdf') return 'pdf';
    if (e === 'docx' || t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    if (e === 'doc' || t === 'application/msword') return 'doc';
    if (t.startsWith('image/') || ['heic', 'heif', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(e)) return 'image';
    return null;
  }

  function isHeic(file) {
    return /^image\/hei[cf]/i.test(file.type) || ['heic', 'heif'].includes(ext(file.name));
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode image'))), type, quality);
    });
  }

  async function canvasToBytes(canvas, type = 'image/jpeg', quality = 0.9) {
    return new Uint8Array(await (await canvasToBlob(canvas, type, quality)).arrayBuffer());
  }

  // ------------------------------------------------------ searchable text

  // The built-in PDF font only covers Latin characters (WinAnsi). Replace
  // anything it can't encode so saving never fails.
  function makeSanitizer(font) {
    const ok = new Map();
    const swaps = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '\t': '    ', ' ': ' ' };
    return (str) => {
      let out = '';
      for (const ch of str) {
        const c = swaps[ch] ?? ch;
        if (!ok.has(c)) {
          let good = true;
          try {
            font.encodeText(c);
            font.widthOfTextAtSize(c, 10);
          } catch {
            good = false;
          }
          ok.set(c, good);
        }
        out += ok.get(c) ? c : '?';
      }
      return out;
    };
  }

  // Writes words with text render mode 3 (invisible): not drawn, but PDF
  // readers can search, select and copy them — the same technique used by
  // scanners and tools like OCRmyPDF. Each word is {text, x, w, baseline, size,
  // rot?}; toPdf maps (x, baseline) to PDF coordinates, and w/size are in
  // points. `rotation` is the page's display rotation; a word's own `rot` is
  // how far it's turned clockwise on screen (after the page was rotated).
  // With { stream: entries }, the text goes into a separate content stream
  // whose dictionary gets those entries (so it can be found and removed later).
  function writeInvisibleText(target, font, clean, words, toPdf, rotation = 0, { stream = null } = {}) {
    const L = PDFLib;
    const fontKey = target.node.newFontDictionary(font.name, font.ref);
    const ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
    for (const w of words) {
      const text = clean(w.text);
      if (!text.trim() || !(w.size > 0)) continue;
      const natural = font.widthOfTextAtSize(text, w.size);
      const squeeze = natural > 0 ? Math.max(1, Math.min(1000, (100 * w.w) / natural)) : 100;
      const [x, y] = toPdf(w.x, w.baseline);
      const rad = ((rotation - (w.rot || 0)) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      ops.push(
        L.setFontAndSize(fontKey, w.size),
        L.setCharacterSqueeze(squeeze),
        L.setTextMatrix(cos, sin, -sin, cos, x, y),
        L.showText(font.encodeText(text)),
      );
    }
    ops.push(L.endText(), L.popGraphicsState());
    if (stream) {
      const ctx = target.doc.context;
      target.node.addContentStream(ctx.register(ctx.contentStream(ops, stream)));
    } else {
      target.pushOperators(...ops);
    }
  }

  // ------------------------------------------------------------- photos

  // Decode to something drawable, with the photo's EXIF rotation applied
  // (otherwise phone photos often come out sideways).
  async function decodeImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode(); // browsers apply EXIF orientation when drawing <img>
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } catch (err) {
      if (!isHeic(file)) throw new Error('this image format could not be read');
    } finally {
      URL.revokeObjectURL(url);
    }
    // Most browsers other than Safari can't read iPhone HEIC photos natively.
    await loadScript(CDN.heicTo);
    const bitmap = await window.HeicTo({ blob: file, type: 'bitmap' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  }

  async function imageToPdf(file) {
    const L = PDFLib;
    const { source, width, height } = await decodeImage(file);
    const shrink = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * shrink));
    canvas.height = Math.max(1, Math.round(height * shrink));
    const ctx = canvas.getContext('2d');
    const keepAlpha = /png|gif|webp/i.test(file.type) || ['png', 'gif', 'webp'].includes(ext(file.name));
    if (!keepAlpha) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close?.();

    const doc = await L.PDFDocument.create();
    const bytes = await canvasToBytes(canvas, keepAlpha ? 'image/png' : 'image/jpeg', 0.9);
    const img = keepAlpha ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    canvas.width = canvas.height = 0;

    const landscape = width > height;
    const [pw, ph] = landscape ? [PHOTO_PAGE[1], PHOTO_PAGE[0]] : PHOTO_PAGE;
    const page = doc.addPage([pw, ph]);
    const fit = Math.min((pw - 2 * PHOTO_MARGIN) / img.width, (ph - 2 * PHOTO_MARGIN) / img.height);
    const w = img.width * fit;
    const h = img.height * fit;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    doc.setTitle(file.name);
    return doc.save();
  }

  // ------------------------------------------------------------- Word

  // Renders the .docx to HTML (docx-preview), takes a picture of each page
  // (html2canvas), and puts the document's real words on top as invisible
  // text, so the result looks like the document and Ctrl+F finds its words.
  async function docxToPdf(file, onProgress) {
    await loadScript(CDN.jszip);
    await Promise.all([loadScript(CDN.docxPreview), loadScript(CDN.html2canvas)]);

    const host = document.createElement('div');
    host.className = 'convert-host';
    const styleHost = document.createElement('div');
    const body = document.createElement('div');
    host.append(styleHost, body);
    document.body.append(host);
    try {
      const prepared = await matchWordSpacing(file);
      // docx-preview turns on the browser's automatic hyphenation, but Word
      // only hyphenates when the document asks for it. (Hyphenated words also
      // came out cut off in the page pictures on Windows and Mac.)
      if (!prepared.autoHyphenation) host.classList.add('no-hyphens');
      await window.docx.renderAsync(prepared.file, body, styleHost, {
        inWrapper: true,
        breakPages: true,
        ignoreWidth: false,
        ignoreHeight: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true,
        experimental: true,
      });
      await document.fonts.ready;
      await Promise.all([...body.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
      fitSpacerRuns(body);

      const sections = [...body.querySelectorAll('section.docx')];
      if (!sections.length) throw new Error('no pages found in this document');

      const L = PDFLib;
      const doc = await L.PDFDocument.create();
      const font = await doc.embedFont(L.StandardFonts.Helvetica);
      const clean = makeSanitizer(font);

      for (let i = 0; i < sections.length; i++) {
        onProgress?.(i / sections.length);
        await sectionToPages(sections[i], doc, font, clean);
      }
      doc.setTitle(file.name.replace(/\.docx$/i, ''));
      return doc.save();
    } finally {
      host.remove();
    }
  }

  // How tall Word's "single" line spacing is, relative to the font size: Word
  // uses the font's own line height (about 1.15 for Times New Roman, Arial and
  // Calibri), while docx-preview turns "single" into a CSS line-height of 1.
  const WORD_SINGLE_LINE = 1.15;

  // Correct the paragraph spacing docx-preview gets wrong, by adjusting the
  // file's spacing settings before it reads them:
  // - "Auto" spacing before/after (Word's HTML-style spacing, used by the
  //   "Normal (Web)" style) is 14 pt in Word; docx-preview ignored the auto
  //   flag and used the fallback value (often 5 pt), squashing paragraphs.
  // - Proportional line spacing is relative to the font's line height in
  //   Word, not to its size, so lines came out too tight.
  // - A line spacing without a rule means "auto" in Word; docx-preview read it
  //   as an exact height.
  async function matchWordSpacing(file) {
    try {
      const zip = await window.JSZip.loadAsync(file);
      const settings = await zip.file('word/settings.xml')?.async('string');
      const autoHyphenation = !!settings && /<w:autoHyphenation(?![^>]*w:val="(?:0|false|off)")[^>]*\/>/.test(settings);
      await applyContextualSpacing(zip);
      const parts = Object.keys(zip.files).filter((n) => /^word\/(document|styles|numbering|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(n));
      let changed = false;
      for (const name of parts) {
        const xml = await zip.file(name).async('string');
        let fixed = xml.replace(/<w:spacing\b([^>]*?)\/>/g, (m, attrs) => `<w:spacing${fixSpacing(attrs)}/>`);
        // Bullets drawn with Symbol / Wingdings characters only show in those
        // fonts (Windows); use the matching standard characters instead.
        if (name === 'word/numbering.xml') fixed = fixed.replace(/[\uf0a7\uf0b7\uf0d8\uf0fc\uf06e\uf076\uf0a8\uf0d7]/g, (ch) => SYMBOL_BULLETS[ch]);
        if (fixed !== xml) {
          zip.file(name, fixed);
          changed = true;
        }
      }
      return { file: changed ? await zip.generateAsync({ type: 'blob' }) : file, autoHyphenation };
    } catch (err) {
      console.warn('Could not adjust the Word spacing; converting as is', err);
      return { file, autoHyphenation: false };
    }
  }

  // Word's "Don't add space between paragraphs of the same style"
  // (contextualSpacing, used by List Paragraph): docx-preview ignores it, which
  // put extra space between every bullet. Write it out as zero spacing
  // between neighbouring paragraphs of the same style.
  async function applyContextualSpacing(zip) {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const stylesXml = await zip.file('word/styles.xml')?.async('string');
    const docFile = zip.file('word/document.xml');
    if (!stylesXml || !docFile) return;
    const parser = new DOMParser();
    const styles = parser.parseFromString(stylesXml, 'application/xml');
    const kids = (el, name) => [...el.childNodes].filter((n) => n.nodeType === 1 && n.namespaceURI === W && n.localName === name);
    const kid = (el, name) => (el ? kids(el, name)[0] : undefined);
    const isOn = (el) => !!el && !['0', 'false', 'off'].includes(el.getAttributeNS(W, 'val'));
    const info = new Map();
    let defaultStyle = null;
    for (const st of styles.getElementsByTagNameNS(W, 'style')) {
      if (st.getAttributeNS(W, 'type') !== 'paragraph') continue;
      const id = st.getAttributeNS(W, 'styleId');
      const cs = kid(kid(st, 'pPr'), 'contextualSpacing');
      info.set(id, { basedOn: kid(st, 'basedOn')?.getAttributeNS(W, 'val'), contextual: cs ? isOn(cs) : undefined });
      if (['1', 'true', 'on'].includes(st.getAttributeNS(W, 'default'))) defaultStyle = id;
    }
    const styleContextual = (id, depth = 0) => {
      const s = info.get(id);
      if (!s || depth > 20) return false;
      return s.contextual !== undefined ? s.contextual : styleContextual(s.basedOn, depth + 1);
    };
    if (![...info.keys()].some((id) => styleContextual(id))) return;

    const doc = parser.parseFromString(await docFile.async('string'), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return;
    const pInfo = (p) => {
      const pPr = kid(p, 'pPr');
      const style = kid(pPr, 'pStyle')?.getAttributeNS(W, 'val') || defaultStyle;
      const own = kid(pPr, 'contextualSpacing');
      return { style, contextual: own ? isOn(own) : styleContextual(style) };
    };
    const setSpacing = (p, side) => {
      let pPr = kid(p, 'pPr');
      if (!pPr) {
        pPr = doc.createElementNS(W, 'w:pPr');
        p.insertBefore(pPr, p.firstChild);
      }
      let sp = kid(pPr, 'spacing');
      if (!sp) {
        sp = doc.createElementNS(W, 'w:spacing');
        pPr.append(sp);
      }
      sp.setAttributeNS(W, `w:${side}`, '0');
      sp.removeAttributeNS(W, `${side}Autospacing`);
    };
    let changed = false;
    // Paragraphs next to each other in the same container (body, table cell…).
    const containers = [doc.getElementsByTagNameNS(W, 'body')[0], ...doc.getElementsByTagNameNS(W, 'tc'), ...doc.getElementsByTagNameNS(W, 'txbxContent')];
    for (const box of containers) {
      if (!box) continue;
      const ps = kids(box, 'p');
      for (let i = 0; i + 1 < ps.length; i++) {
        if (ps[i].nextElementSibling !== ps[i + 1]) continue; // something (a table…) in between
        const a = pInfo(ps[i]);
        const b = pInfo(ps[i + 1]);
        if (a.style !== b.style) continue;
        if (a.contextual) setSpacing(ps[i], 'after');
        if (b.contextual) setSpacing(ps[i + 1], 'before');
        changed = changed || a.contextual || b.contextual;
      }
    }
    if (changed) zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  }

  // Word's single line height for common fonts (their Windows ascent +
  // descent, which is what Word uses), relative to the font size.
  const SINGLE_LINE = {
    'times new roman': 1.107, 'liberation serif': 1.107, tinos: 1.107,
    calibri: 1.221, carlito: 1.221,
    arial: 1.117, 'liberation sans': 1.117, arimo: 1.117, helvetica: 1.117,
    cambria: 1.172, caladea: 1.172,
    georgia: 1.136, garamond: 1.12, 'book antiqua': 1.17, 'palatino linotype': 1.17,
    aptos: 1.2, verdana: 1.215, tahoma: 1.207, 'century gothic': 1.225, 'courier new': 1.133,
  };

  function singleLineOf(fontFamily) {
    for (const name of fontFamily.split(',')) {
      const f = name.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (SINGLE_LINE[f]) return SINGLE_LINE[f];
    }
    return WORD_SINGLE_LINE;
  }

  const SYMBOL_BULLETS = {
    '\uf0b7': '\u2022', // Symbol bullet •
    '\uf0a7': '\u25aa', // Wingdings small square ▪
    '\uf0d8': '\u27a2', // Wingdings arrowhead ➢
    '\uf0fc': '\u2713', // Wingdings check ✓
    '\uf06e': '\u25a0', // Wingdings square ■
    '\uf076': '\u2756', // Wingdings diamond ❖
    '\uf0a8': '\u25e6', // Symbol white bullet ◦
    '\uf0d7': '\u25b8', // Symbol small triangle ▸
  };

  function fixSpacing(attrs) {
    const get = (k) => (attrs.match(new RegExp(`\\bw:${k}="([^"]*)"`)) || [])[1];
    const set = (k, v) => {
      const re = new RegExp(`\\bw:${k}="[^"]*"`);
      attrs = re.test(attrs) ? attrs.replace(re, `w:${k}="${v}"`) : `${attrs} w:${k}="${v}"`;
    };
    const drop = (k) => { attrs = attrs.replace(new RegExp(`\\s*\\bw:${k}="[^"]*"`), ''); };
    const on = (v) => v === '1' || v === 'true' || v === 'on';
    if (on(get('beforeAutospacing'))) {
      set('before', 280); // 14 pt
      drop('beforeAutospacing');
    }
    if (on(get('afterAutospacing'))) {
      set('after', 280);
      drop('afterAutospacing');
    }
    const line = get('line');
    if (line != null && (get('lineRule') || 'auto') === 'auto') {
      set('line', Math.round(Number(line) * WORD_SINGLE_LINE));
      set('lineRule', 'auto');
    }
    return attrs;
  }

  // Documents often push something to the right margin with a long run of
  // spaces (a date on a résumé line, say). In Word the spaces squeeze into
  // the margin; in the browser a hair of extra width wraps the date onto the
  // next line. Tighten such runs just enough to keep the line together.
  function fitSpacerRuns(root) {
    // A paragraph's own font size sets a minimum line height in the browser
    // (in Word, only the text on the line counts). Give each paragraph the
    // size of its largest text, so lines aren't taller than in Word.
    for (const p of root.querySelectorAll('section.docx p')) {
      const spans = [...p.querySelectorAll('span')].filter((sp) => sp.textContent.trim());
      if (!spans.length) continue;
      const sizes = spans.map((sp) => parseFloat(getComputedStyle(sp).fontSize));
      const big = sizes.indexOf(Math.max(...sizes));
      // Proportional line spacing was written as a multiple of WORD_SINGLE_LINE;
      // use the main font's own single line height instead.
      const lh = getComputedStyle(p).lineHeight;
      const fs = parseFloat(getComputedStyle(p).fontSize);
      const multiple = lh === 'normal' ? null : parseFloat(lh) / fs / WORD_SINGLE_LINE;
      p.style.fontSize = `${sizes[big]}px`;
      if (multiple && p.dataset.lineFixed !== '1') {
        p.style.lineHeight = String(multiple * singleLineOf(getComputedStyle(spans[big]).fontFamily));
        p.dataset.lineFixed = '1';
      }
      spans.forEach((sp, i) => {
        if (Math.abs(parseFloat(getComputedStyle(sp).fontSize) - sizes[i]) > 0.01) sp.style.fontSize = `${sizes[i]}px`;
      });
    }
    for (const span of root.querySelectorAll('section.docx span')) {
      if (!/^[ \u00a0]{8,}$/.test(span.textContent)) continue;
      const p = span.closest('p');
      if (!p || !p.lastChild || !span.getClientRects().length) continue;
      const rest = document.createRange();
      rest.setStartAfter(span);
      rest.setEndAfter(p.lastChild);
      // Anything after the spaces on a later line than where the spaces start?
      const wraps = () => {
        const top = span.getClientRects()[0].top;
        return [...rest.getClientRects()].some((r) => r.width > 0 && r.top - top > 2);
      };
      for (let ls = 0; wraps() && ls > -3; ls -= 0.25) span.style.letterSpacing = `${ls - 0.25}px`;
      if (wraps()) span.style.letterSpacing = ''; // couldn't fit it: leave as it was
    }
  }

  async function sectionToPages(section, doc, font, clean) {
    const cs = getComputedStyle(section);
    const width = section.offsetWidth;
    const fullHeight = section.offsetHeight;
    const pageHeight = parseFloat(cs.minHeight) || width * (11 / 8.5);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;

    const words = collectWords(section);

    // A section can be taller than one page when Word's page breaks aren't
    // recorded in the file; split it between lines of text.
    const slices = [];
    let start = 0;
    while (start < fullHeight - 1) {
      const first = slices.length === 0;
      const avail = first ? pageHeight - padBottom : pageHeight - padTop - padBottom;
      const end = start + avail;
      // (2px of slack: rounding can make a page a fraction taller than its size.)
      if (end >= fullHeight - padBottom - 2) {
        slices.push([start, fullHeight]);
        break;
      }
      let cut = end;
      for (let moved = true; moved;) {
        moved = false;
        for (const w of words) {
          if (w.top < cut && w.bottom > cut) {
            cut = w.top;
            moved = true;
          }
        }
      }
      if (cut <= start + avail * 0.25) cut = end; // e.g. one huge picture: cut through it
      slices.push([start, cut]);
      start = cut;
    }

    // html2canvas lays out a copy of the page. Give it the stylesheets that
    // are already loaded instead of letting it download them again, which
    // fails offline and could make the copy's layout differ. (When the page
    // is opened as a local file the browser won't let us read them; then the
    // copy just loads them itself.)
    let sheetsCss = null;
    try {
      sheetsCss = [...document.styleSheets].filter((s) => s.href)
        .map((s) => [...s.cssRules].map((r) => r.cssText).join('\n'));
    } catch {
      sheetsCss = null;
    }
    const shot = await window.html2canvas(section, {
      scale: DOCX_RENDER_SCALE,
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
      ...(sheetsCss && {
        ignoreElements: (el) => el.tagName === 'LINK' && /stylesheet/i.test(el.rel),
        onclone: (doc) => {
          for (const css of sheetsCss) {
            const style = doc.createElement('style');
            style.textContent = css;
            doc.head.append(style);
          }
        },
      }),
    });
    const scaleY = shot.height / fullHeight;

    for (let k = 0; k < slices.length; k++) {
      const [s, e] = slices[k];
      const offset = k === 0 ? 0 : padTop;
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = shot.width;
      sliceCanvas.height = Math.max(1, Math.round((e - s) * scaleY));
      const ctx = sliceCanvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      ctx.drawImage(shot, 0, Math.round(s * scaleY), shot.width, sliceCanvas.height, 0, 0, sliceCanvas.width, sliceCanvas.height);
      const jpg = await doc.embedJpg(await canvasToBytes(sliceCanvas, 'image/jpeg', 0.92));
      sliceCanvas.width = sliceCanvas.height = 0;

      const pw = width * PX_TO_PT;
      const ph = pageHeight * PX_TO_PT;
      const page = doc.addPage([pw, ph]);
      const imgH = (e - s) * PX_TO_PT;
      page.drawImage(jpg, { x: 0, y: ph - offset * PX_TO_PT - imgH, width: pw, height: imgH });

      const sliceWords = words
        .filter((w) => (w.top + w.bottom) / 2 >= s && (w.top + w.bottom) / 2 < e)
        .map((w) => ({
          text: w.text,
          x: w.x * PX_TO_PT,
          w: w.w * PX_TO_PT,
          baseline: (w.baseline - s + offset) * PX_TO_PT,
          size: w.size * PX_TO_PT,
        }));
      if (sliceWords.length) writeInvisibleText(page, font, clean, sliceWords, (x, y) => [x, ph - y]);
    }
    shot.width = shot.height = 0;
  }

  // Every word in the rendered page, with its position relative to the page.
  function collectWords(section) {
    const origin = section.getBoundingClientRect();
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const words = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.data.trim()) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const size = parseFloat(style.fontSize) || 12;
      for (const m of node.data.matchAll(/\S+/g)) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getClientRects()[0];
        if (!r || r.width < 0.5 || r.height < 0.5) continue;
        const top = r.top - origin.top;
        const bottom = r.bottom - origin.top;
        words.push({
          text: m[0],
          x: r.left - origin.left,
          w: r.width,
          top,
          bottom,
          // The glyph box's lower ~20% is below the baseline (descenders).
          baseline: bottom - r.height * 0.2,
          size,
        });
      }
    }
    return words;
  }

  // ---------------------------------------------------- protected PDFs
  //
  // pdf-lib can't save encrypted ("protected") PDFs, so before saving we let
  // qpdf (https://qpdf.sourceforge.io, compiled to WebAssembly, runs locally)
  // remove the encryption, and optionally put a password back afterwards.

  async function runQpdf(args, input) {
    await loadScript(CDN.qpdfJs);
    const createQpdf = window.Module; // qpdf.js defines this global
    const messages = [];
    const qpdf = await createQpdf({
      locateFile: () => CDN.qpdfWasm,
      print: () => {},
      printErr: (text) => messages.push(text),
    });
    qpdf.FS.writeFile('/in.pdf', input);
    let code;
    try {
      code = qpdf.callMain(args);
    } catch (err) {
      code = typeof err?.status === 'number' ? err.status : 2;
      if (typeof err?.status !== 'number') messages.push(String(err));
    }
    // qpdf exit codes: 0 = fine, 3 = fine with warnings, 2 = failed.
    if (code !== 0 && code !== 3) {
      const msg = messages.join(' ');
      throw new Error(/invalid password/i.test(msg) ? 'the password is wrong' : msg || `qpdf failed (${code})`);
    }
    return qpdf.FS.readFile('/out.pdf');
  }

  /** Returns qpdf's rewrite of the PDF, which repairs many kinds of damage. */
  function repairPdf(bytes) {
    return runQpdf(['/in.pdf', '/out.pdf'], bytes);
  }

  /** Loads pdf-lib if it failed to load with the page (e.g. the connection dropped). */
  async function ensurePdfLib() {
    if (typeof window.PDFLib === 'undefined') await loadScript(lib('pdf-lib@1.17.1/dist/pdf-lib.min.js'));
  }

  /** Returns a copy of the PDF with its encryption and edit restrictions removed. */
  function unlockPdf(bytes, password = '') {
    return runQpdf(['--decrypt', `--password=${password}`, '/in.pdf', '/out.pdf'], bytes);
  }

  /** Returns a copy of the PDF that needs `password` to open (AES-256). */
  function lockPdf(bytes, password) {
    return runQpdf(['/in.pdf', '--encrypt', `--user-password=${password}`, `--owner-password=${password}`,
      '--bits=256', '--', '/out.pdf'], bytes);
  }

  // ------------------------------------------------------------- entry

  /** Returns PDF bytes for a supported non-PDF file. */
  async function toPdf(file, onProgress) {
    const kind = kindOf(file);
    if (kind === 'image') return imageToPdf(file);
    if (kind === 'docx') return docxToPdf(file, onProgress);
    if (kind === 'doc') {
      throw new Error('old-style .doc files can\'t be converted. Open it in Word or Google Docs and save it as .docx or PDF first');
    }
    throw new Error('this file type isn\'t supported');
  }

  window.PdfConvert = { kindOf, toPdf, makeSanitizer, writeInvisibleText, unlockPdf, lockPdf, repairPdf, ensurePdfLib };
})();
