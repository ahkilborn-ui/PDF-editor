// Writes THIRD-PARTY-NOTICES.txt: the open-source libraries PDF Editor uses
// (the offline app ships copies of them in app/vendor/), with their
// copyright notices and license texts. Run by build-offline.mjs.

import fs from 'node:fs';
import path from 'node:path';

// For each library: what it is, its license, and where the license text
// comes from (a file in its npm package, or tools/licenses/).
const COMPONENTS = [
  { name: 'PDF.js', pkg: 'pdfjs-dist', use: 'shows PDF pages', url: 'https://github.com/mozilla/pdf.js',
    copyright: 'Copyright Mozilla Foundation and contributors', license: 'Apache-2.0', text: 'pdfjs-dist/LICENSE' },
  { name: 'pdf-lib', pkg: 'pdf-lib', use: 'writes PDFs when saving', url: 'https://github.com/Hopding/pdf-lib',
    license: 'MIT', text: 'pdf-lib/LICENSE.md' },
  { name: 'Tesseract.js', pkg: 'tesseract.js', use: 'reads text in scanned pages (OCR)', url: 'https://github.com/naptha/tesseract.js',
    copyright: 'Copyright Project Naptha and contributors', license: 'Apache-2.0', text: 'tesseract.js/LICENSE.md' },
  { name: 'tesseract.js-core (Tesseract OCR, compiled to WebAssembly)', pkg: 'tesseract.js-core', url: 'https://github.com/naptha/tesseract.js-core',
    copyright: 'Tesseract OCR: Copyright Google and contributors (https://github.com/tesseract-ocr/tesseract)', license: 'Apache-2.0', text: 'tesseract.js-core/LICENSE' },
  { name: 'Leptonica (inside tesseract.js-core)', url: 'http://www.leptonica.org',
    copyright: 'Copyright (C) Leptonica (Dan Bloomberg). All rights reserved.', license: 'BSD-2-Clause', text: 'licenses/BSD-2-Clause.txt' },
  { name: 'English OCR data (tessdata)', pkg: '@tesseract.js-data/eng', url: 'https://github.com/tesseract-ocr/tessdata_best',
    copyright: 'Copyright Google', license: 'Apache-2.0', text: 'pdfjs-dist/LICENSE' },
  { name: 'heic-to', pkg: 'heic-to', use: 'reads iPhone HEIC photos', url: 'https://github.com/hoppergee/heic-to',
    copyright: 'Copyright hoppergee and contributors. Includes libheif (https://github.com/strukturag/libheif, LGPL-3.0, ' +
      'Copyright struktur AG) and libde265 (https://github.com/strukturag/libde265, LGPL-3.0, Copyright struktur AG).',
    license: 'LGPL-3.0-or-later', text: ['heic-to/LICENSE', 'licenses/GPL-3.0.txt'],
    note: 'heic-to is used unmodified, as the separate file vendor/heic-to@<version>/dist/iife/heic-to.js in the offline app; ' +
      'you may replace that file with your own build. Its source code is at the address above.' },
  { name: 'JSZip', pkg: 'jszip', use: 'opens Word files', url: 'https://github.com/Stuk/jszip',
    license: 'MIT (chosen from MIT OR GPL-3.0-or-later)', text: 'jszip/LICENSE.markdown' },
  { name: 'docx-preview', pkg: 'docx-preview', use: 'lays out Word files', url: 'https://github.com/VolodymyrBaydalka/docxjs',
    copyright: 'Copyright Volodymyr Baydalka and contributors', license: 'Apache-2.0', text: 'docx-preview/LICENSE' },
  { name: 'html2canvas', pkg: 'html2canvas', use: 'captures Word pages as images', url: 'https://github.com/niklasvh/html2canvas',
    license: 'MIT', text: 'html2canvas/LICENSE' },
  { name: 'qpdf-wasm (QPDF compiled to WebAssembly)', pkg: '@neslinesli93/qpdf-wasm', use: 'unlocks, repairs and password-protects PDFs',
    url: 'https://github.com/neslinesli93/qpdf-wasm', copyright: 'Copyright neslinesli93 and contributors', license: 'ISC', text: 'licenses/ISC.txt' },
  { name: 'QPDF (inside qpdf-wasm)', url: 'https://github.com/qpdf/qpdf',
    copyright: 'Copyright (c) Jay Berkenbilt and contributors', license: 'Apache-2.0', text: 'pdfjs-dist/LICENSE' },
  { name: 'libjpeg-turbo (inside qpdf-wasm)', url: 'https://github.com/libjpeg-turbo/libjpeg-turbo',
    copyright: 'Copyright (C) 2009-2021 D. R. Commander. Copyright (C) 2015 Viktor Szathmáry. ' +
      'This software is based in part on the work of the Independent JPEG Group (Copyright (C) 1991-2020, Thomas G. Lane, Guido Vollbeding).',
    license: 'IJG, BSD-3-Clause and Zlib', text: ['licenses/IJG.txt', 'licenses/BSD-3-Clause.txt', 'licenses/Zlib.txt'] },
  { name: 'Jost (typeface)', pkg: '@fontsource/jost', use: 'the font used throughout the app', url: 'https://github.com/indestructible-type/Jost',
    copyright: 'Copyright 2020 The Jost Project Authors', license: 'SIL Open Font License 1.1', text: '@fontsource/jost/LICENSE' },
  { name: 'zlib (inside qpdf-wasm)', url: 'https://zlib.net',
    copyright: 'Copyright (C) Jean-loup Gailly and Mark Adler', license: 'Zlib', text: 'licenses/Zlib.txt' },
];

export function writeNotices(root, outFile) {
  const nm = path.join(root, 'node_modules');
  const read = (rel) => {
    const file = rel.startsWith('licenses/') ? path.join(root, 'tools', rel) : path.join(nm, rel);
    if (!fs.existsSync(file)) throw new Error(`notices: missing ${file}`);
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  };
  const version = (pkg) => JSON.parse(fs.readFileSync(path.join(nm, pkg, 'package.json'), 'utf8')).version;
  const line = '='.repeat(78);
  const parts = [
    'Hale\'s PDF Editor',
    '',
    fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').trim(),
    '',
    line,
    '',
    'PDF Editor uses the following open-source software. The installable offline',
    'app includes copies of these libraries (in its vendor/ folder); the browser',
    'version loads the same files from the jsDelivr CDN.',
    '',
  ];
  // Each distinct license text once, listing who uses it.
  const LABELS = {
    'licenses/GPL-3.0.txt': 'GNU General Public License v3 (the LGPL above adds to it)',
  };
  const texts = new Map(); // license text -> { label, names }
  for (const c of COMPONENTS) {
    const v = c.pkg ? ` ${version(c.pkg)}` : '';
    parts.push(`- ${c.name}${v}${c.use ? ` — ${c.use}` : ''}`);
    parts.push(`  ${c.url}`);
    if (c.copyright) parts.push(`  ${c.copyright}`);
    parts.push(`  License: ${c.license}`);
    if (c.note) parts.push(`  ${c.note}`);
    parts.push('');
    for (const t of [c.text].flat()) {
      const body = read(t);
      const key = body.replace(/\s+/g, ' ');
      if (!texts.has(key)) texts.set(key, { body, label: LABELS[t], names: [] });
      if (!texts.get(key).names.includes(c.name)) texts.get(key).names.push(c.name);
    }
  }
  for (const { body, label, names } of texts.values()) {
    parts.push(line, label ? `${label} — for: ${names.join('; ')}` : `License text for: ${names.join('; ')}`, line, '', body, '');
  }
  fs.writeFileSync(outFile, parts.join('\n'));
}
