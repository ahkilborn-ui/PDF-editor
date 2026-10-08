/* Keeps edits editable after saving.
 *
 * Highlights, text boxes, rectangles, white-out boxes and drawings are saved
 * as standard PDF annotations (Highlight, FreeText, Square, Ink), each with
 * its own appearance, so every PDF reader shows and prints them, and Acrobat
 * can edit them. Each annotation also carries the editor's own description
 * of the item (/PDFEditorItem), so when the file is reopened here the item
 * comes back exactly as it was and can be moved, changed or deleted.
 *
 * Typed text also gets an invisible copy in a separate, marked content
 * stream so Ctrl+F finds it in any reader; that stream is removed again on
 * reopening so the text isn't duplicated.
 *
 * Exposes window.PdfEditable.
 */
(() => {
  'use strict';

  const ITEM_KEY = 'PDFEditorItem';
  const SEARCH_KEY = 'PDFEditorSearchText';
  const FORMAT_VERSION = 1;

  function rgbOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => Math.round(v * 1000) / 1000);
  }

  function bounds(points, pad = 0) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  }

  /**
   * Add the editor's items for one page to `target` (a pdf-lib page).
   *   items     editor items on this page (page units, see app.js)
   *   vp        the page's pdf.js viewport at scale 1 (converts page units to PDF space)
   *   font      embedded Helvetica (pdf-lib PDFFont); clean: makes text encodable
   *   text      { padding, lineHeight, baseline } — the editor's text box layout
   *   highlightOpacity
   */
  function writeItems(doc, target, items, { vp, font, clean, text, highlightOpacity, writeInvisibleText }) {
    const L = PDFLib;
    const ctx = doc.context;
    const rot = vp.rotation;
    const toPdf = (x, y) => vp.convertToPdfPoint(x, y);
    const rectToPdf = (a) => {
      const [x1, y1] = toPdf(a.x, a.y);
      const [x2, y2] = toPdf(a.x + a.w, a.y + a.h);
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    };
    const searchWords = [];

    const add = (subtype, rect, ops, resources, entries, a, contents) => {
      const appearance = ctx.formXObject(ops, { BBox: rect, Resources: resources });
      const dict = ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: rect, F: 4, Border: [0, 0, 0], ...entries });
      dict.set(L.PDFName.of('AP'), ctx.obj({ N: ctx.register(appearance) }));
      dict.set(L.PDFName.of('P'), target.ref);
      dict.set(L.PDFName.of('M'), L.PDFString.fromDate(new Date()));
      if (contents != null) dict.set(L.PDFName.of('Contents'), L.PDFHexString.fromText(contents));
      // The editor's own description, so the item is fully editable when reopened here.
      const { id, page, isNew, ...item } = a;
      dict.set(L.PDFName.of(ITEM_KEY), L.PDFHexString.fromText(JSON.stringify({ v: FORMAT_VERSION, rot, item })));
      target.node.addAnnot(ctx.register(dict));
    };

    for (const a of items) {
      const rgb = rgbOf(a.color);
      const color = L.rgb(...rgb);

      if (a.type === 'highlight') {
        const [x1, y1, x2, y2] = rectToPdf(a);
        const gs = ctx.obj({ Type: 'ExtGState', ca: highlightOpacity, CA: highlightOpacity, BM: 'Multiply' });
        add('Highlight', [x1, y1, x2, y2], [
          L.pushGraphicsState(), L.setGraphicsState('GS0'), L.setFillingColor(color),
          L.rectangle(x1, y1, x2 - x1, y2 - y1), L.fill(), L.popGraphicsState(),
        ], { ExtGState: { GS0: gs } }, { C: rgb, CA: highlightOpacity, QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1] }, a);

      } else if (a.type === 'whiteout') {
        const [x1, y1, x2, y2] = rectToPdf(a);
        add('Square', [x1, y1, x2, y2], [
          L.pushGraphicsState(), L.setFillingColor(color), L.rectangle(x1, y1, x2 - x1, y2 - y1), L.fill(), L.popGraphicsState(),
        ], {}, { C: rgb, IC: rgb, BS: { W: 0 } }, a);

      } else if (a.type === 'rect') {
        // On screen the border is drawn inside the box; PDF strokes are
        // centered on the line, so inset by half the line width.
        const [x1, y1, x2, y2] = rectToPdf(a);
        const half = Math.min(a.width / 2, (x2 - x1) / 2, (y2 - y1) / 2);
        add('Square', [x1, y1, x2, y2], [
          L.pushGraphicsState(), L.setStrokingColor(color), L.setLineWidth(a.width),
          ...(a.fill ? [L.setFillingColor(color)] : []),
          L.rectangle(x1 + half, y1 + half, x2 - x1 - 2 * half, y2 - y1 - 2 * half),
          a.fill ? L.fillAndStroke() : L.stroke(), L.popGraphicsState(),
        ], {}, { C: rgb, ...(a.fill ? { IC: rgb } : {}), BS: { W: a.width } }, a);

      } else if (a.type === 'ink') {
        const pts = a.points.map(([x, y]) => toPdf(x, y));
        if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]); // a dot
        const rect = bounds(pts, a.width);
        add('Ink', rect, [
          L.pushGraphicsState(), L.setStrokingColor(color), L.setLineWidth(a.width),
          L.setLineCap(L.LineCapStyle.Round), L.setLineJoin(L.LineJoinStyle.Round),
          L.moveTo(pts[0][0], pts[0][1]), ...pts.slice(1).map(([x, y]) => L.lineTo(x, y)),
          L.stroke(), L.popGraphicsState(),
        ], {}, { C: rgb, BS: { W: a.width }, InkList: [pts.flat()] }, a);

      } else if (a.type === 'text') {
        // a.rot: how far the box is turned clockwise on screen (pages rotated after typing).
        const turn = ((a.rot || 0) * Math.PI) / 180;
        const angle = rot - (a.rot || 0); // text direction in PDF space, degrees counter-clockwise
        const rad = (angle * Math.PI) / 180;
        const ops = [];
        const corners = [];
        a.text.split('\n').forEach((line, k) => {
          const dx = text.padding;
          const dy = text.padding + a.size * text.lineHeight * k + a.size * text.baseline;
          const [x, y] = toPdf(a.x + dx * Math.cos(turn) - dy * Math.sin(turn), a.y + dx * Math.sin(turn) + dy * Math.cos(turn));
          const str = clean(line);
          const width = str ? font.widthOfTextAtSize(str, a.size) : 0;
          // Corners of this line's box, from below the baseline to the top of capitals.
          for (const [u, v] of [[0, -0.25 * a.size], [width, -0.25 * a.size], [0, a.size], [width, a.size]]) {
            corners.push([x + u * Math.cos(rad) - v * Math.sin(rad), y + u * Math.sin(rad) + v * Math.cos(rad)]);
          }
          if (!str) return;
          ops.push(...L.drawText(font.encodeText(str), {
            color, font: 'F1', size: a.size, rotate: L.degrees(angle), xSkew: L.degrees(0), ySkew: L.degrees(0), x, y,
          }));
          searchWords.push({ text: str, x, baseline: y, w: width, size: a.size, rot: -angle });
        });
        const rect = bounds(corners, 2);
        add('FreeText', rect, ops, { Font: { F1: font.ref } }, {
          DA: L.PDFString.of(`/Helv ${a.size} Tf ${rgb.join(' ')} rg`), C: [],
        }, a, a.text);
      }
    }

    // Typed text, invisible but searchable, in its own marked stream.
    if (searchWords.length) {
      writeInvisibleText(target, font, clean, searchWords, (x, y) => [x, y], 0, { stream: { [SEARCH_KEY]: true } });
    }
  }

  /**
   * Find the editor's items in a PDF it saved earlier. Returns
   * { bytes, items: [{ index, rot, item }] } where `bytes` is the file with
   * those annotations (and the search-text streams) removed, or null if the
   * file has none.
   */
  async function readItems(bytes) {
    const L = PDFLib;
    let doc;
    try {
      doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
    } catch {
      return null; // encrypted or unreadable: leave the file as it is
    }
    const found = [];
    let changed = false;
    doc.getPages().forEach((page, index) => {
      const annots = page.node.Annots();
      if (annots) {
        for (let i = annots.size() - 1; i >= 0; i--) {
          const dict = doc.context.lookup(annots.get(i));
          const data = dict instanceof L.PDFDict ? dict.get(L.PDFName.of(ITEM_KEY)) : null;
          if (!data || typeof data.decodeText !== 'function') continue;
          try {
            const parsed = JSON.parse(data.decodeText());
            if (parsed && parsed.item && parsed.v === FORMAT_VERSION) found.push({ index, order: i, rot: parsed.rot || 0, item: parsed.item });
          } catch {
            continue;
          }
          annots.remove(i);
          changed = true;
        }
      }
      const contents = page.node.Contents();
      if (contents instanceof L.PDFArray) {
        for (let i = contents.size() - 1; i >= 0; i--) {
          const stream = doc.context.lookup(contents.get(i));
          if (stream?.dict?.get(L.PDFName.of(SEARCH_KEY))) {
            contents.remove(i);
            changed = true;
          }
        }
      }
    });
    if (!changed) return null;
    found.sort((a, b) => a.index - b.index || a.order - b.order);
    return { bytes: await doc.save(), items: found };
  }

  window.PdfEditable = { writeItems, readItems };
})();
