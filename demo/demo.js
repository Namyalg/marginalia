'use strict';
/**
 * End-to-end demonstration on a real document with a real clipboard image.
 *
 * Drives the actual app: opens a downloaded PDF, highlights real selected text
 * the way Preview does, types with the Text tool, pastes whatever image is on
 * the system clipboard, saves, then reopens the saved file. Writes out the
 * app window screenshot, the pasted image, and before/after page renders.
 *
 * Run: npx electron demo/demo.js <file.pdf>
 */
process.env.PDFA_SELFTEST = '1';

// Piping this into `head`, or quitting `less` early, closes stdout underneath
// us. Without this an EPIPE from the next write goes uncaught, and in an
// Electron main process that means a modal "A JavaScript error occurred"
// dialog instead of a quiet exit.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
}


const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = __dirname;
const SRC = process.argv.find((a) => a.endsWith('.pdf')) || path.join(OUT, 'attention.pdf');
const WORK = path.join(OUT, 'annotated.pdf');
// PyObjC lives in a project-local venv by default; see the README. Checks that
// need it report "skipped" rather than failing when it is absent.
const VENV = process.env.PDFKIT_PYTHON ||
  path.join(__dirname, '..', '.venv', 'bin', 'python');

require(path.join(ROOT, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

function rasterize(file, out, size = 1100) {
  const dir = path.join(OUT, '.ql');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  qlRun(file, dir, size);
  const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
  fs.copyFileSync(path.join(dir, png), out);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  let win;
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) break;
    await wait(100);
  }
  win.setSize(1280, 980);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  win.webContents.on('console-message', (e, level, message) => {
    const text = (e && e.message) || message;
    if (text) process.stdout.write(`  [renderer] ${text}\n`);
  });

  fs.copyFileSync(SRC, WORK);
  console.log(`source: ${path.basename(SRC)}`);

  // The image already sitting on the system clipboard -- put there by a real
  // screenshot, not synthesised here.
  const clip = JSON.parse(await js(
    `(async () => JSON.stringify(await window.api.readClipboardImage()))()`));
  if (!clip.ok) { console.error('no image on the clipboard:', clip.reason); app.exit(1); return; }
  fs.writeFileSync(path.join(OUT, 'pasted-clipboard-image.png'), Buffer.from(clip.data, 'base64'));
  console.log(`clipboard: ${clip.width}x${clip.height} png (${clip.origin})`);

  await js(`(async () => window.__app.openDocument(
    await window.api.openPdf(${JSON.stringify(WORK)})))()`);
  await wait(3000);

  const report = JSON.parse(await js(`(async () => {
    const mark = (m) => console.log('demo-step: ' + m);
    mark('start');
    const A = window.__app, S = A.state;
    const page = S.pages[0];
    const spans = [...page.textLayerDiv.querySelectorAll('span')]
      .filter(s => s.textContent.trim().length > 25);

    // --- Highlight, the Preview way: select text, then mark it up ----------
    A.setTool('highlight');
    S.color = [1, 0.92, 0.23];
    let r = document.createRange();
    r.setStart(spans[2].firstChild, 0);
    r.setEnd(spans[4].firstChild, spans[4].firstChild.length);
    let sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    const highlighted = sel.toString();
    A.applyTextMarkup();

    mark('highlighted');
    // --- Underline a different passage, in blue ---------------------------
    A.setTool('underline');
    S.color = [0.2, 0.45, 0.95];
    r = document.createRange();
    r.selectNodeContents(spans[6]);
    sel.removeAllRanges(); sel.addRange(r);
    const underlined = sel.toString();
    A.applyTextMarkup();

    // --- Strike through a third -------------------------------------------
    A.setTool('strikeout');
    S.color = [0.9, 0.2, 0.2];
    r = document.createRange();
    r.selectNodeContents(spans[8]);
    sel.removeAllRanges(); sel.addRange(r);
    const struck = sel.toString();
    A.applyTextMarkup();
    sel.removeAllRanges();

    mark('text markup done');
    // --- The Text tool: a typed comment box --------------------------------
    const vp = page.pdfPage.getViewport({ scale: 1 });
    const msg = 'Typed with the Text tool — this text box was added by the annotator and wraps automatically.';
    const rect = { x: 60, y: vp.height - 250, w: 250, h: 70 };
    A.snapshot();
    S.annots.push({ id: A.uid(), page: 0, type: 'freetext', color: [0.85, 0.15, 0.15],
      fontSize: 11, rect, text: msg, lines: A.wrapText(msg, 11, rect.w - 4) });

    // --- A sticky note ------------------------------------------------------
    S.annots.push({ id: A.uid(), page: 0, type: 'note', color: [1, 0.85, 0.3],
      rect: { x: vp.width - 70, y: vp.height - 70, w: 20, h: 20 },
      text: 'A sticky note, same as Preview drops on the page.' });

    // --- An arrow pointing at something -------------------------------------
    S.annots.push({ id: A.uid(), page: 0, type: 'arrow', color: [0.95, 0.45, 0.05],
      strokeWidth: 2.5, points: [[330, vp.height - 250], [430, vp.height - 205]] });

    A.redrawAll();

    mark('shapes + text done');
    // --- Paste the clipboard image -----------------------------------------
    await A.pasteImage();
    const img = S.annots.find(a => a.type === 'image');
    if (!img) { mark('PASTE PRODUCED NO IMAGE'); }
    // Park it low on the page so it does not cover the marked-up text.
    if (img) {
      img.rect.x = vp.width / 2 - img.rect.w / 2;
      img.rect.y = 90;
      img.rotation = 6;                   // a slight tilt, to show rotation
    }
    S.selectedId = null;
    A.redrawAll();

    mark('pasted; saving');
    await A.save(false);
    mark('saved');

    return JSON.stringify({
      highlighted: highlighted.slice(0, 90),
      underlined: underlined.slice(0, 60),
      struck: struck.slice(0, 60),
      total: S.annots.length,
      types: S.annots.map(a => a.type),
      dirty: S.dirty,
      imageRect: img ? img.rect : null,
      imageRotation: img ? img.rotation : null,
    });
  })()`));

  const step = async (label, work, ms = 90000) => {
    process.stdout.write(`  … ${label}\n`);
    const t = Date.now();
    const out = await Promise.race([
      work(),
      wait(ms).then(() => { throw new Error(`${label} timed out after ${ms / 1000}s`); }),
    ]);
    process.stdout.write(`  ✓ ${label} (${Date.now() - t}ms)\n`);
    return out;
  };

  await wait(1200);
  await step('capture the annotated window', async () =>
    fs.writeFileSync(path.join(OUT, 'app-window.png'),
      (await win.capturePage()).toPNG()));

  // Reopen the saved file in the app, proving the marks persisted.
  await step('reopen the saved file', () => js(`(async () => {
    await window.__app.openDocument(
      await window.api.openPdf(${JSON.stringify(WORK)}));
    return 'reopened';
  })()`));
  await wait(2500);
  await step('capture the reopened window', async () =>
    fs.writeFileSync(path.join(OUT, 'app-window-reopened.png'),
      (await win.capturePage()).toPNG()));

  await step('render page 1 before', async () => rasterize(SRC, path.join(OUT, 'page1-before.png')));
  await step('render page 1 after', async () => rasterize(WORK, path.join(OUT, 'page1-after.png')));

  const kit = fs.existsSync(VENV)
    ? JSON.parse(execFileSync(VENV,
        [path.join(ROOT, 'test', 'verify-pdfkit.py'), WORK], { encoding: 'utf8' }))
    : null;
  const mine = kit ? kit.annotations.filter((a) => a.page === 0 && a.type !== 'Link') : [];

  console.log('');
  console.log('highlighted : "' + report.highlighted + '…"');
  console.log('underlined  : "' + report.underlined + '…"');
  console.log('struck      : "' + report.struck + '…"');
  console.log('annotations : ' + report.total + ' — ' + report.types.join(', '));
  console.log('image       : ' + (report.imageRect
    ? report.imageRect.w.toFixed(0) + 'x' + report.imageRect.h.toFixed(0) +
      'pt, rotated ' + report.imageRotation + '°'
    : 'NONE — paste did not produce an image'));
  console.log('saved clean : ' + (!report.dirty));
  console.log('');
  if (!kit) {
    console.log('(PDFKit verification skipped -- no .venv with PyObjC)');
    app.exit(0); return;
  }
  console.log('PDFKit (the framework Preview uses) reads back from the saved file:');
  for (const a of mine) {
    console.log(`  /${a.type.padEnd(10)} rect ${a.rect.map((v) => v.toFixed(0)).join(',').padEnd(22)}` +
      (a.contents ? ` "${String(a.contents).replace(/\s+/g, ' ').slice(0, 46)}"` : ''));
  }
  const links = kit.annotations.filter((a) => a.type === 'Link').length;
  console.log(`  (${links} pre-existing Link annotations in the original were preserved)`);
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => {
  console.error('demo failed:', e);
  app.exit(1);
}));
