'use strict';
/**
 * Head-to-head: our highlight vs the one macOS Preview itself would draw.
 *
 * PDFKit is the framework Preview is built on, so a highlight created through
 * PDFKit is the reference. We highlight the same sentence through the app's
 * own text-selection path, render both files with CoreGraphics, and compare
 * the painted pixels.
 *
 * Run: npx electron test/compare-preview.js [file.pdf] ["sentence to match"]
 */
process.env.PDFA_SELFTEST = '1';

// Piping this into `head`, or quitting `less` early, closes stdout underneath
// us. Without this an EPIPE from the next write goes uncaught, and in an
// Electron main process that means a modal "A JavaScript error occurred"
// dialog instead of a quiet exit.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
}


const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { decodePng } = require('./png');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfannot-cmp-'));
// PyObjC lives in a project-local venv by default; see the README. Checks that
// need it report "skipped" rather than failing when it is absent.
const VENV = process.env.PDFKIT_PYTHON ||
  path.join(__dirname, '..', '.venv', 'bin', 'python');

const SRC = process.argv.find((a) => a.endsWith('.pdf') && !a.includes('node_modules'))
  || path.join(ROOT, 'demo', 'attention.pdf');
const PHRASE = process.argv[process.argv.length - 1].endsWith('.pdf')
  ? 'The dominant sequence transduction models are based on complex recurrent'
  : process.argv[process.argv.length - 1];

require(path.join(ROOT, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
/** qlmanage occasionally stalls when the QuickLook daemon is busy; never let
 *  that hang the run. One retry, then give up loudly. */
function qlRun(file, dir, size) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execFileSync('qlmanage', ['-t', '-s', String(size), '-o', dir, file],
        { stdio: 'ignore', timeout: 60000 });
      return;
    } catch (e) {
      if (attempt) throw new Error(`qlmanage failed for ${file}: ${e.message}`);
    }
  }
}

function rasterize(file, size = 1400) {
  const dir = path.join(TMP, 'ql' + (seq++));
  fs.mkdirSync(dir, { recursive: true });
  qlRun(file, dir, size);
  const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
  if (!png) throw new Error('qlmanage produced nothing for ' + file);
  return decodePng(fs.readFileSync(path.join(dir, png)));
}

/** Boolean mask of "this pixel was painted yellow". */
function yellowMask(img) {
  const m = new Uint8Array(img.width * img.height);
  for (let i = 0; i < m.length; i++) {
    const o = i * img.channels;
    const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
    // Yellow ink over white paper or black glyphs: red and green high-ish,
    // blue clearly lower. Works for both the paper and the text underneath.
    m[i] = (r > 120 && g > 100 && b < Math.min(r, g) - 45) ? 1 : 0;
  }
  return m;
}

function maskStats(mask, w, h) {
  let n = 0, minX = w, maxX = -1, minY = h, maxY = -1;
  const rows = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      n++; rows[y]++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  // Count distinct horizontal bands (runs of rows that contain ink).
  let bands = 0, inBand = false;
  for (let y = 0; y < h; y++) {
    const on = rows[y] > 2;
    if (on && !inBand) bands++;
    inBand = on;
  }
  return { pixels: n, minX, maxX, minY, maxY, bands };
}

async function main() {
  let win;
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) break;
    await wait(100);
  }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ---- Preview's own highlight -------------------------------------------
  const refPdf = path.join(TMP, 'preview-reference.pdf');
  if (!fs.existsSync(VENV)) {
    console.error('This comparison needs PDFKit via PyObjC:\n' +
      '  python3 -m venv .venv && .venv/bin/pip install pyobjc-framework-Quartz\n' +
      `(looked for ${VENV}; override with PDFKIT_PYTHON)`);
    app.exit(2); return;
  }
  const refOut = JSON.parse(execFileSync(VENV,
    [path.join(__dirname, 'pdfkit-highlight.py'), SRC, refPdf, PHRASE],
    { encoding: 'utf8' }));
  if (refOut.error) throw new Error('PDFKit reference failed: ' + refOut.error);

  // ---- our highlight, through the real selection path ---------------------
  const minePdf = path.join(TMP, 'ours.pdf');
  fs.copyFileSync(SRC, minePdf);
  await js(`(async () => window.__app.openDocument(
    await window.api.openPdf(${JSON.stringify(minePdf)})))()`);
  await wait(3500);

  const sel = JSON.parse(await js(`(async () => {
    const A = window.__app, page = A.state.pages[0];
    const needle = ${JSON.stringify(PHRASE)};

    // Walk the text layer, building a flat string plus a map back to nodes,
    // so we can select exactly the same characters PDFKit matched.
    const nodes = [];
    let flat = '';
    for (const span of page.textLayerDiv.querySelectorAll('span')) {
      const t = span.firstChild;
      if (!t || t.nodeType !== 3) continue;
      nodes.push({ node: t, start: flat.length, text: t.data });
      flat += t.data;
    }
    const norm = (s) => s.replace(/\\s+/g, ' ');
    let idx = flat.indexOf(needle);
    if (idx < 0) {
      // Fall back to whitespace-insensitive matching.
      const target = norm(needle);
      for (let i = 0; i < flat.length && idx < 0; i++) {
        if (norm(flat.slice(i, i + target.length + 8)).startsWith(target)) idx = i;
      }
    }
    if (idx < 0) return JSON.stringify({ error: 'phrase not found in the text layer' });
    const end = idx + needle.length;
    const locate = (pos) => {
      for (const n of nodes) {
        if (pos >= n.start && pos <= n.start + n.text.length) {
          return [n.node, pos - n.start];
        }
      }
      return null;
    };
    const a0 = locate(idx), a1 = locate(end);
    if (!a0 || !a1) return JSON.stringify({ error: 'could not map the phrase to nodes' });

    A.setTool('highlight');
    A.state.color = [1, 0.90, 0.20];
    const range = document.createRange();
    range.setStart(a0[0], a0[1]);
    range.setEnd(a1[0], a1[1]);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(range);
    const picked = s.toString();
    const rawRects = range.getClientRects().length;
    const rawBoxes = [...range.getClientRects()].map(r => {
      const [bx0, by0] = A.toPdf(page, r.left, r.bottom);
      const [bx1, by1] = A.toPdf(page, r.right, r.top);
      return { x0: +Math.min(bx0,bx1).toFixed(2), x1: +Math.max(bx0,bx1).toFixed(2),
               y0: +Math.min(by0,by1).toFixed(2), y1: +Math.max(by0,by1).toFixed(2) };
    });
    A.applyTextMarkup();
    const hl = A.state.annots.filter(x => x.type === 'highlight');
    await A.save(false);
    return JSON.stringify({
      picked: picked.slice(0, 80),
      rawRects,
      annotations: hl.length,
      quads: hl.reduce((n, x) => n + x.quads.length, 0),
      rawBoxes,
      bands: hl.flatMap(x => x.quads.map(q => ({
        x0: +q[0].toFixed(2), x1: +q[2].toFixed(2),
        y1: +q[1].toFixed(2), y0: +q[5].toFixed(2),
      }))),
    });
  })()`));
  if (sel.error) throw new Error(sel.error);

  // ---- compare -----------------------------------------------------------
  const ref = rasterize(refPdf), mine = rasterize(minePdf);
  if (ref.width !== mine.width || ref.height !== mine.height) {
    throw new Error('renders differ in size; cannot compare');
  }
  const mRef = yellowMask(ref), mMine = yellowMask(mine);
  const sRef = maskStats(mRef, ref.width, ref.height);
  const sMine = maskStats(mMine, mine.width, mine.height);

  let inter = 0, union = 0;
  for (let i = 0; i < mRef.length; i++) {
    if (mRef[i] || mMine[i]) union++;
    if (mRef[i] && mMine[i]) inter++;
  }
  const iou = union ? inter / union : 0;
  const px2pt = 792 / ref.height;

  const line = (label, s) =>
    `${label.padEnd(10)} ${String(s.pixels).padStart(7)} px   ` +
    `x ${(s.minX * px2pt * (612 / 792) / (ref.width / ref.height) / 1).toFixed(0).padStart(4)}` +
    `..${(s.maxX * 612 / ref.width).toFixed(0).padEnd(4)}  ` +
    `y ${(792 - s.maxY * px2pt).toFixed(1).padStart(6)}..${(792 - s.minY * px2pt).toFixed(1).padEnd(6)}  ` +
    `bands ${s.bands}`;

  console.log('');
  console.log(`document : ${path.basename(SRC)}`);
  console.log(`phrase   : "${PHRASE.slice(0, 70)}"`);
  console.log(`selected : "${sel.picked}…"`);
  console.log(`geometry : ${sel.rawRects} raw selection rects → ${sel.quads} tidied bands`);
  console.log(`PDFKit   : ${JSON.stringify(refOut.annotations.map(a => a.rect))}`);
  console.log(`raw rects: ${JSON.stringify(sel.rawBoxes)}`);
  console.log(`bands    : ${JSON.stringify(sel.bands)}`);
  console.log('');
  console.log('painted highlight, measured from the CoreGraphics render:');
  console.log(line('Preview', sRef));
  console.log(line('ours', sMine));
  console.log('');
  console.log(`overlap (IoU) : ${(iou * 100).toFixed(1)}%`);
  console.log(`area ratio    : ${(sMine.pixels / sRef.pixels).toFixed(2)}x Preview's`);
  console.log(`band count    : ours ${sMine.bands}, Preview ${sRef.bands}`);
  console.log(`artifacts     : ${TMP}`);

  fs.copyFileSync(refPdf, path.join(ROOT, 'demo', 'compare-preview-reference.pdf'));
  fs.copyFileSync(minePdf, path.join(ROOT, 'demo', 'compare-ours.pdf'));
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => {
  console.error('comparison failed:', e);
  app.exit(1);
}));
