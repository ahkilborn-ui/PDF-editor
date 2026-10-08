// Builds the installable, offline version of the editor into app/.
//
//   npm install
//   npm run build
//
// The browser version (index.html at the repo root) loads its libraries from
// the jsDelivr CDN. This script makes app/ from the same source files, but
// with every library copied into app/vendor/, plus a web app manifest and a
// service worker that stores everything on the device so it works offline.
//
// app/ is generated: edit the files at the repo root (or in offline/), then
// re-run this script and commit the result.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'app');
const NM = path.join(ROOT, 'node_modules');
const CDN = 'https://cdn.jsdelivr.net/npm/';

// Every library file the editor can load, written exactly as in app.js,
// convert.js and index.html ("<package>@<version>/<path>"). A trailing slash
// copies a whole folder.
const VENDOR = [
  'pdfjs-dist@4.10.38/build/pdf.min.mjs',
  'pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
  'pdfjs-dist@4.10.38/cmaps/',
  'pdfjs-dist@4.10.38/standard_fonts/',
  'pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'tesseract.js@5.1.1/dist/tesseract.min.js',
  'tesseract.js@5.1.1/dist/worker.min.js',
  // OCR runs in LSTM-only mode; the worker picks the SIMD build when the CPU supports it.
  'tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js',
  'tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js',
  '@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
  'heic-to@1.5.2/dist/iife/heic-to.js',
  'jszip@3.10.1/dist/jszip.min.js',
  'docx-preview@0.4.0/dist/docx-preview.min.js',
  'html2canvas@1.4.1/dist/html2canvas.min.js',
  '@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.js',
  '@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm',
];

const SHARED = ['app.js', 'convert.js', 'editable.js', 'styles.css'];

function fail(msg) {
  console.error(`build-offline: ${msg}`);
  process.exit(1);
}

function parseSpec(spec) {
  const m = /^((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.*)$/.exec(spec);
  if (!m) fail(`can't parse library path "${spec}"`);
  return { pkg: m[1], version: m[2], file: m[3] };
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// 1. Every library the source refers to must be in VENDOR, or the offline app
//    would silently need the internet for it.
const sources = ['index.html', 'app.js', 'convert.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const referenced = new Set([
  ...[...sources.matchAll(/\blib\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...sources.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/([^"'\s)]+)/g)].map((m) => m[1]),
]);
for (const ref of referenced) {
  if (!VENDOR.some((v) => v === ref || v.startsWith(ref.endsWith('/') ? ref : `${ref}/`))) {
    fail(`"${ref}" is used by the app but not listed in VENDOR in tools/build-offline.mjs`);
  }
}

// 2. Start from an empty app/ so removed files don't linger.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

// 3. Libraries -> app/vendor/<package>@<version>/...
for (const spec of VENDOR) {
  const { pkg, version, file } = parseSpec(spec);
  const pkgDir = path.join(NM, pkg);
  if (!fs.existsSync(pkgDir)) fail(`${pkg} isn't installed. Run "npm install" first.`);
  const installed = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  if (installed !== version) fail(`${pkg} is ${installed} in node_modules but the app uses ${version}. Run "npm install".`);
  const src = path.join(pkgDir, file);
  const dest = path.join(OUT, 'vendor', `${pkg}@${version}`, file);
  if (spec.endsWith('/')) {
    for (const f of walk(src)) copy(f, path.join(dest, path.relative(src, f)));
  } else {
    if (!fs.existsSync(src)) fail(`missing ${src}`);
    copy(src, dest);
  }
}

// 4. The editor itself, icons, and the offline-only files.
for (const f of SHARED) copy(path.join(ROOT, f), path.join(OUT, f));
for (const f of fs.readdirSync(path.join(ROOT, 'icons'))) copy(path.join(ROOT, 'icons', f), path.join(OUT, 'icons', f));
copy(path.join(ROOT, 'offline', 'install.js'), path.join(OUT, 'install.js'));
copy(path.join(ROOT, 'offline', 'manifest.webmanifest'), path.join(OUT, 'manifest.webmanifest'));

// 5a. Stamp the browser version's index.html with a version for its own
//     files ("styles.css?v=…"), so after an update a browser can't pair the
//     new page with an old cached stylesheet or script.
const stamp = crypto.createHash('sha256');
for (const f of SHARED) stamp.update(fs.readFileSync(path.join(ROOT, f)));
const v = stamp.digest('hex').slice(0, 10);
const rootHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/(href|src)="(styles\.css|app\.js|convert\.js|editable\.js)(\?v=[\w]+)?"/g, `$1="$2?v=${v}"`);
fs.writeFileSync(path.join(ROOT, 'index.html'), rootHtml);

// 5b. index.html: local libraries, manifest, install script; drop browser-only bits.
let html = rootHtml;
html = html.replaceAll(CDN, 'vendor/');
html = html.replace(/\s*<([a-z]+)[^>]*\bdata-browser-only\b[^>]*>[\s\S]*?<\/\1>/g, '');
html = html.replace('<title>PDF Editor</title>', [
  '<title>PDF Editor</title>',
  '  <meta name="theme-color" content="#2563eb">',
  '  <link rel="manifest" href="manifest.webmanifest">',
  '  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
  '  <script>window.PDF_EDITOR_LIB_BASE = \'vendor/\';</script>',
].join('\n'));
html = html.replace(/(<script src="app\.js[^"]*" defer><\/script>)/, '$1\n  <script src="install.js" defer></script>');
if (!html.includes('install.js')) fail('could not add install.js to app/index.html');
if (html.includes(CDN)) fail('index.html still refers to the CDN');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// 6. Service worker: precache every file. Its version is a hash of all of
//    them, so any change makes installed apps download the update.
const files = walk(OUT).map((f) => path.relative(OUT, f).split(path.sep).join('/')).sort();
const hash = crypto.createHash('sha256');
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(OUT, f)));
const version = hash.digest('hex').slice(0, 12);
const sw = fs.readFileSync(path.join(ROOT, 'offline', 'sw.js'), 'utf8')
  .replace('__VERSION__', version)
  .replace('__FILES__', JSON.stringify(['./', ...files], null, 2));
fs.writeFileSync(path.join(OUT, 'sw.js'), sw);

const bytes = files.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`Built app/ (version ${version}): ${files.length + 1} files, ${(bytes / 1048576).toFixed(1)} MB`);
