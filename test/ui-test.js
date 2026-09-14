'use strict';
/**
 * Drives the REAL app -- real main process, real preload bridge, real renderer,
 * real clipboard -- then verifies the saved file with independent engines
 * (PDFKit via PyObjC, CoreGraphics via qlmanage).
 *
 * Run: npm run test:ui
 */
process.env.PDFA_SELFTEST = '1';

// Piping this into `head`, or quitting `less` early, closes stdout underneath
// us. Without this an EPIPE from the next write goes uncaught, and in an
// Electron main process that means a modal "A JavaScript error occurred"
// dialog instead of a quiet exit.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
}


const { app, BrowserWindow, clipboard, ClipboardItem, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { decodePng, diffRatio, regionMean } = require('./png');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfannot-ui-'));
// PyObjC lives in a project-local venv by default; see the README. Checks that
// need it report "skipped" rather than failing when it is absent.
const VENV = process.env.PDFKIT_PYTHON ||
  path.join(__dirname, '..', '.venv', 'bin', 'python');

let pass = 0, fail = 0;
const log = [];
function record(status, name, detail) {
  if (status === 'PASS') pass++; else if (status === 'FAIL') fail++;
  log.push([status, name, detail || '']);
}
const TIMEOUT_MS = 60000;
async function check(name, fn) {
  let timer;
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(
        () => rej(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); }),
    ]);
    record('PASS', name, result);
  } catch (e) {
    record('FAIL', name, e.message);
  } finally {
    clearTimeout(timer);
  }
  const [status, , detail] = log[log.length - 1];
  process.stdout.write(`  ${status === 'PASS' ? 'ok  ' : 'FAIL'} ${name}` +
    `${detail ? '  -- ' + detail : ''}\n`);
}
const assert = (c, m) => { if (!c) throw new Error(m); };

/* Seeding the clipboard is version-dependent: Electron 44 swapped the sync
   main-process clipboard for an async, ClipboardItem-based one. The app copes
   with both, so the harness has to as well. */
const MODERN_CLIPBOARD = typeof clipboard.writeImage !== 'function';

async function putImage(file) {
  clipboard.clear();
  if (!MODERN_CLIPBOARD) return clipboard.writeImage(nativeImage.createFromPath(file));
  const buf = fs.readFileSync(file);
  await clipboard.write([new ClipboardItem({
    'image/png': new Blob([buf], { type: 'image/png' }),
  })]);
}

async function putFileUrl(file) {
  clipboard.clear();
  const url = 'file://' + encodeURI(file);
  if (!MODERN_CLIPBOARD) return clipboard.writeBuffer('public.file-url', Buffer.from(url));
  await clipboard.write([new ClipboardItem({
    'text/uri-list': new Blob([Buffer.from(url)], { type: 'text/uri-list' }),
  })]);
}

function putText(text) {
  clipboard.clear();
  clipboard.writeText(text);
}

function pdfkit(file) {
  if (!fs.existsSync(VENV)) return null;
  return JSON.parse(execFileSync(VENV, [path.join(__dirname, 'verify-pdfkit.py'), file],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}
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

function rasterize(file, size = 900) {
  const dir = path.join(TMP, 'ql' + (seq++));
  fs.mkdirSync(dir, { recursive: true });
  qlRun(file, dir, size);
  const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
  assert(png, `qlmanage produced nothing for ${path.basename(file)}`);
  return decodePng(fs.readFileSync(path.join(dir, png)));
}

// Load the real app's main process (menus, IPC handlers, protocol, window).
require(path.join(ROOT, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWindow() {
  for (let i = 0; i < 200; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) return w;
    await wait(100);
  }
  throw new Error('the app window never finished loading');
}

async function run() {
  const win = await getWindow();
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // Surface renderer errors -- a silent exception in the page would otherwise
  // show up only as an inscrutable assertion failure.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('  [renderer]', message);
  });
  win.webContents.on('render-process-gone', (_e, d) =>
    console.error('  [renderer gone]', JSON.stringify(d)));

  // Work on a copy so a plain Save (which overwrites in place) is safe.
  const work = path.join(TMP, 'working.pdf');
  fs.copyFileSync(path.join(FIX, 'plain.pdf'), work);

  // --- the clipboard, seeded the way a real copy would leave it -----------
  await putImage(path.join(FIX, 'clip.png'));

  await check('renderer booted with the preload bridge', async () => {
    const keys = await js('Object.keys(window.api).sort().join(",")');
    assert(keys.includes('savePdf') && keys.includes('readClipboardImage'),
      `bridge exposed: ${keys}`);
    const leaked = await js('typeof require + "," + typeof process');
    assert(leaked === 'undefined,undefined',
      `renderer can see Node internals (${leaked}) -- context isolation is broken`);
    return `api = ${keys}; no Node in renderer`;
  });

  await check('opens a PDF and renders every page', async () => {
    await js(`(async () => window.__app.openDocument(
      await window.api.openPdf(${JSON.stringify(work)})))()`);
    await wait(1200);
    const info = await js(`JSON.stringify({
      pages: window.__app.state.pages.length,
      spans: window.__app.state.pages[0].textLayerDiv.querySelectorAll('span').length,
      canvasW: window.__app.state.pages[0].canvas.width,
    })`);
    const o = JSON.parse(info);
    assert(o.pages === 3, `rendered ${o.pages} pages, expected 3`);
    assert(o.spans > 5, `text layer has only ${o.spans} spans -- selection will not work`);
    assert(o.canvasW > 100, 'page canvas has no size');
    return `${o.pages} pages, ${o.spans} text spans on page 1`;
  });

  await check('canvas actually contains rendered page content', async () => {
    const ink = await js(`(() => {
      const c = window.__app.state.pages[0].canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return dark;
    })()`);
    assert(ink > 500, `only ${ink} dark pixels on the page canvas -- nothing rendered`);
    return `${ink} dark pixels rendered`;
  });

  // --- real text selection -> highlight ------------------------------------
  await check('selecting text produces highlight quads on the right page', async () => {
    const out = await js(`(() => {
      const A = window.__app;
      A.setTool('highlight');
      const spans = [...A.state.pages[0].textLayerDiv.querySelectorAll('span')]
        .filter(s => s.textContent.trim().length > 3);
      const r = document.createRange();
      r.setStart(spans[1].firstChild, 0);
      r.setEnd(spans[2].firstChild, spans[2].firstChild.length);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      const text = sel.toString();
      A.applyTextMarkup();
      const hl = A.state.annots.filter(a => a.type === 'highlight');
      return JSON.stringify({ n: hl.length, page: hl[0] && hl[0].page,
        quads: hl.reduce((s,a)=>s+a.quads.length,0), text: text.slice(0,40) });
    })()`);
    const o = JSON.parse(out);
    assert(o.n >= 1, 'selection produced no highlight annotation');
    assert(o.page === 0, `highlight landed on page index ${o.page}`);
    assert(o.quads >= 1, 'highlight has no quads');
    return `${o.n} highlight(s), ${o.quads} quad(s), from "${o.text}…"`;
  });

  await check('underline and strikethrough use the same selection path', async () => {
    const out = await js(`(() => {
      const A = window.__app;
      const spans = [...A.state.pages[0].textLayerDiv.querySelectorAll('span')]
        .filter(s => s.textContent.trim().length > 3);
      for (const [tool, i] of [['underline', 3], ['strikeout', 4]]) {
        A.setTool(tool);
        const r = document.createRange();
        r.selectNodeContents(spans[i]);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        A.applyTextMarkup();
      }
      const t = A.state.annots.map(a => a.type);
      return JSON.stringify({ u: t.filter(x=>x==='underline').length,
                              s: t.filter(x=>x==='strikeout').length });
    })()`);
    const o = JSON.parse(out);
    assert(o.u >= 1 && o.s >= 1, `underline=${o.u} strikeout=${o.s}`);
    return `underline ${o.u}, strikeout ${o.s}`;
  });

  // --- shapes, sketch, text, note -----------------------------------------
  await check('shape, sketch, text and note annotations can be created', async () => {
    const out = await js(`(() => {
      const A = window.__app, S = A.state;
      S.annots.push(
        { id: A.uid(), page: 0, type: 'square', color: [0.1,0.6,0.25], strokeWidth: 3,
          rect: { x: 380, y: 560, w: 170, h: 70 } },
        { id: A.uid(), page: 0, type: 'circle', color: [0.55,0.2,0.8], strokeWidth: 3,
          rect: { x: 380, y: 470, w: 170, h: 70 } },
        { id: A.uid(), page: 0, type: 'line', color: [0.1,0.1,0.1], strokeWidth: 2,
          points: [[72,560],[340,520]] },
        { id: A.uid(), page: 0, type: 'arrow', color: [0.95,0.4,0.05], strokeWidth: 3,
          points: [[72,480],[340,430]] },
        { id: A.uid(), page: 0, type: 'ink', color: [0,0.5,0.6], strokeWidth: 2.5,
          paths: [Array.from({length: 40}, (_, i) => [80 + i*6, 380 + Math.sin(i/3)*18])] },
        { id: A.uid(), page: 1, type: 'note', color: [1,0.85,0.3], size: 20,
          rect: { x: 520, y: 700, w: 20, h: 20 }, text: 'Second page note.' },
      );
      const text = 'Typed with the Text tool. Long enough that it must wrap across lines.';
      const rect = { x: 72, y: 250, w: 260, h: 80 };
      S.annots.push({ id: A.uid(), page: 0, type: 'freetext', color: [0.05,0.05,0.05],
        fontSize: 14, rect, text, lines: A.wrapText(text, 14, rect.w - 4) });
      S.dirty = true;
      A.redrawAll();
      const ft = S.annots.find(a => a.type === 'freetext');
      return JSON.stringify({ total: S.annots.length, lines: ft.lines.length,
        svg: S.pages[0].svg.childElementCount });
    })()`);
    const o = JSON.parse(out);
    assert(o.lines >= 2, `FreeText wrapped to ${o.lines} line(s); wrapping is not working`);
    assert(o.svg >= 8, `only ${o.svg} annotation groups drawn on page 1`);
    return `${o.total} annotations, FreeText wrapped to ${o.lines} lines, ${o.svg} drawn`;
  });

  // --- clipboard image -----------------------------------------------------
  await check('pastes the clipboard image onto the current page', async () => {
    const out = await js(`(async () => {
      const A = window.__app;
      await A.pasteImage();
      const im = A.state.annots.filter(a => a.type === 'image');
      const a = im[im.length - 1];
      return JSON.stringify({ n: im.length, rect: a && a.rect,
        bytes: a ? A.state.images[a.imageId].length : 0 });
    })()`);
    const o = JSON.parse(out);
    assert(o.n === 1, `expected 1 pasted image, got ${o.n}`);
    assert(o.bytes > 100, 'no image bytes were captured from the clipboard');
    const ar = o.rect.w / o.rect.h;
    assert(Math.abs(ar - 64 / 48) < 0.02,
      `aspect ratio ${ar.toFixed(3)} does not match the source 64x48 (1.333)`);
    return `${o.rect.w.toFixed(0)}x${o.rect.h.toFixed(0)}pt, aspect preserved, ${o.bytes} b64 bytes`;
  });

  await check('text on the clipboard pastes as a text box', async () => {
    // Long enough to wrap at any of the font sizes the tool can pick.
    putText('Pasted straight from the clipboard. This sentence is deliberately ' +
      'long so that it has to wrap onto several lines no matter what font size ' +
      'the text tool happens to be set to when the paste happens.');
    const out = await js(`(async () => {
      const A = window.__app;
      const before = A.state.annots.filter(a => a.type === 'freetext').length;
      await A.pasteClipboard();
      const ft = A.state.annots.filter(a => a.type === 'freetext');
      const a = ft[ft.length - 1];
      return JSON.stringify({ before, after: ft.length,
        text: a && a.text.slice(0, 30), lines: a && a.lines.length,
        h: a && a.rect.h, images: A.state.annots.filter(x => x.type === 'image').length });
    })()`);
    const o = JSON.parse(out);
    assert(o.after === o.before + 1, `text boxes went ${o.before} → ${o.after}`);
    assert(o.lines >= 2, `pasted text did not wrap (${o.lines} line)`);
    assert(o.h > 10, `box is ${o.h}pt tall`);
    return `"${o.text}…" in ${o.lines} lines, ${o.h.toFixed(0)}pt tall`;
  });

  await check('editing a text box keeps its text and takes ⌘V inline', async () => {
    putText('INSERTED');
    const out = await js(`(async () => {
      const A = window.__app;
      const ft = A.state.annots.filter(x => x.type === 'freetext');
      const a = ft[ft.length - 1];
      const page = A.state.pages[a.page];
      A.state.selectedId = a.id;
      A.redrawAll();
      const hit = [...page.svg.querySelectorAll('.hit.movable')]
        .find(el => el.dataset.id === a.id);
      const r = hit.getBoundingClientRect();
      hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      await new Promise(res => setTimeout(res, 400));
      const ta = document.querySelector('.ftEditor');
      if (!ta) return JSON.stringify({ opened: false });
      const before = ta.value, annots = A.state.annots.length;
      ta.focus();
      await window.api.pasteIntoField();
      await new Promise(res => setTimeout(res, 300));
      return JSON.stringify({ opened: true, kept: ta.value.startsWith(before),
        inserted: ta.value.includes('INSERTED'),
        noNewAnnot: A.state.annots.length === annots });
    })()`);
    const o = JSON.parse(out);
    assert(o.opened, 'double-click did not open the editor');
    assert(o.kept, 'opening the editor destroyed the existing text');
    assert(o.inserted, '⌘V did not paste into the field');
    assert(o.noNewAnnot, '⌘V created a new annotation instead of pasting inline');
    return 'caret at the end, paste lands inline, no stray annotation';
  });

  await check('a non-image clipboard is reported, not silently ignored', async () => {
    clipboard.clear();
    const out = await js(`(async () =>
      JSON.stringify(await window.api.readClipboardImage()))()`);
    const o = JSON.parse(out);
    assert(!o.ok, 'an empty clipboard was treated as pasteable');
    assert(/no image|empty|nothing/i.test(o.reason), `unhelpful message: ${o.reason}`);
    await putImage(path.join(FIX, 'clip.png'));
    return o.reason;
  });

  await check('an image file copied in Finder is read from disk', async () => {
    await putFileUrl(path.join(FIX, 'clip.png'));
    const out = await js(`(async () =>
      JSON.stringify(await window.api.readClipboardImage()))()`);
    const o = JSON.parse(out);
    assert(o.ok, `file-url clipboard was not handled: ${o.reason}`);
    assert(o.origin.startsWith('file:'), `origin was ${o.origin}`);
    assert(o.width === 64 && o.height === 48, `read ${o.width}x${o.height}, expected 64x48`);
    return `${o.origin} ${o.width}x${o.height}`;
  });

  // --- direct manipulation of the pasted image -----------------------------
  // Driven with real PointerEvents so the hit areas, handles and drag capture
  // are all exercised, not just the underlying model.
  const POINTER = `
    const evt = (type, x, y, extra) => new PointerEvent(type, Object.assign(
      { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true,
        cancelable: true, pointerId: 1, isPrimary: true }, extra || {}));
    const drag = (el, from, to, extra) => {
      el.dispatchEvent(evt('pointerdown', from[0], from[1], extra));
      window.dispatchEvent(evt('pointermove', to[0], to[1], extra));
      window.dispatchEvent(evt('pointerup', to[0], to[1], extra));
    };
    const centreOf = (el) => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    const imageAnnot = () => window.__app.state.annots.find(a => a.type === 'image');
  `;

  await check('the pasted image can be dragged to a new position', async () => {
    const out = await js(`(() => {
      ${POINTER}
      const A = window.__app, page = A.state.pages[0];
      A.setTool('select');
      const a = imageAnnot();
      A.state.selectedId = a.id;
      A.redrawAll();
      const before = { x: a.rect.x, y: a.rect.y, w: a.rect.w, h: a.rect.h };
      const hit = [...page.svg.querySelectorAll('.hit.movable')]
        .find(el => el.dataset.id === a.id);
      const from = centreOf(hit);
      drag(hit, from, [from[0] + 60, from[1] + 40]);
      const after = imageAnnot().rect;
      // 60px right / 40px down on screen, converted through the page scale.
      const r = page.canvas.getBoundingClientRect();
      const expectDx = 60 * (page.viewport.width / r.width) / A.state.scale;
      const expectDy = 40 * (page.viewport.height / r.height) / A.state.scale;
      return JSON.stringify({ before, after, expectDx, expectDy });
    })()`);
    const o = JSON.parse(out);
    const dx = o.after.x - o.before.x, dy = o.after.y - o.before.y;
    assert(Math.abs(dx - o.expectDx) < 1.5,
      `moved ${dx.toFixed(1)}pt right, expected ${o.expectDx.toFixed(1)}`);
    assert(Math.abs(dy + o.expectDy) < 1.5,
      `moved ${dy.toFixed(1)}pt in y, expected ${(-o.expectDy).toFixed(1)} (PDF y is up)`);
    assert(o.after.w === o.before.w && o.after.h === o.before.h,
      'dragging changed the image size');
    return `moved ${dx.toFixed(1)}, ${dy.toFixed(1)}pt; size unchanged`;
  });

  await check('the pasted image can be resized by its corner handle', async () => {
    const out = await js(`(() => {
      ${POINTER}
      const A = window.__app, page = A.state.pages[0];
      const a = imageAnnot();
      A.state.selectedId = a.id;
      A.redrawAll();
      const before = { w: a.rect.w, h: a.rect.h };
      const h = page.svg.querySelector('[data-handle="se"]');
      const from = centreOf(h);
      drag(h, from, [from[0] + 50, from[1] + 50]);
      const after = imageAnnot().rect;
      return JSON.stringify({ before, after: { w: after.w, h: after.h } });
    })()`);
    const o = JSON.parse(out);
    assert(o.after.w > o.before.w + 20,
      `width went ${o.before.w.toFixed(1)} -> ${o.after.w.toFixed(1)}`);
    assert(o.after.h > o.before.h + 20,
      `height went ${o.before.h.toFixed(1)} -> ${o.after.h.toFixed(1)}`);
    return `${o.before.w.toFixed(0)}x${o.before.h.toFixed(0)} → ` +
           `${o.after.w.toFixed(0)}x${o.after.h.toFixed(0)}pt`;
  });

  await check('the pasted image can be rotated by its grip', async () => {
    const out = await js(`(() => {
      ${POINTER}
      const A = window.__app, page = A.state.pages[0];
      const a = imageAnnot();
      a.rotation = 0;
      A.state.selectedId = a.id;
      A.redrawAll();
      const grip = page.svg.querySelector('[data-handle="rotate"]');
      const M = A.imageViewMatrix(page, a);
      const c = A.applyM(M, 0.5, 0.5);
      const r = page.canvas.getBoundingClientRect();
      const sx = r.width / page.viewport.width, sy = r.height / page.viewport.height;
      const centreClient = [r.left + c[0] * sx, r.top + c[1] * sy];
      const from = centreOf(grip);
      const rad = Math.hypot(from[0] - centreClient[0], from[1] - centreClient[1]);
      // Drag the grip a quarter turn clockwise around the centre.
      const startAng = Math.atan2(from[1] - centreClient[1], from[0] - centreClient[0]);
      const target = [centreClient[0] + rad * Math.cos(startAng + Math.PI / 2),
                      centreClient[1] + rad * Math.sin(startAng + Math.PI / 2)];
      drag(grip, from, target);
      return JSON.stringify({ rotation: imageAnnot().rotation });
    })()`);
    const o = JSON.parse(out);
    assert(Math.abs(o.rotation - 90) < 3,
      `a quarter-turn drag produced ${o.rotation.toFixed(1)}°, expected ~90°`);
    return `${o.rotation.toFixed(1)}° after a quarter-turn drag`;
  });

  await check('Rotate Image Left/Right step by 90°', async () => {
    const out = await js(`(() => {
      const A = window.__app;
      const a = A.state.annots.find(x => x.type === 'image');
      a.rotation = 0;
      A.state.selectedId = a.id;
      A.rotateSelected(90);  const r1 = a.rotation;
      A.rotateSelected(90);  const r2 = a.rotation;
      A.rotateSelected(-90); const r3 = a.rotation;
      A.rotateSelected(-90); const r4 = a.rotation;
      A.rotateSelected(-90); const r5 = a.rotation;
      return JSON.stringify([r1, r2, r3, r4, r5]);
    })()`);
    const o = JSON.parse(out);
    assert(JSON.stringify(o) === JSON.stringify([90, 180, 90, 0, 270]),
      `rotation sequence was ${JSON.stringify(o)}`);
    return `90 → 180 → 90 → 0 → 270 (wraps correctly)`;
  });

  await check('what is on screen is what gets saved (rotated image)', async () => {
    const rotFile = path.join(TMP, 'rotated-image.pdf');
    const out = await js(`(async () => {
      const A = window.__app, page = A.state.pages[0];
      const a = A.state.annots.find(x => x.type === 'image');
      a.rotation = 35;
      A.state.selectedId = null;
      A.redrawAll();
      // The image's on-screen corners, mapped back into PDF user space.
      const r = page.canvas.getBoundingClientRect();
      const pdfCorners = A.imageCorners(page, a).map(([vx, vy]) =>
        page.viewport.convertToPdfPoint(vx, vy));
      const xs = pdfCorners.map(p => p[0]), ys = pdfCorners.map(p => p[1]);
      // Save this probe to its own file, then hand the document back to the
      // working copy so later checks are not affected.
      const probeRotation = a.rotation;
      const originalPath = A.state.path;
      A.state.path = ${JSON.stringify(rotFile)};
      await A.save(false);
      A.state.path = originalPath;
      A.state.name = originalPath.split('/').pop();
      a.rotation = 0;
      A.state.dirty = true;
      A.redrawAll();
      return JSON.stringify({
        aabb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        rotation: probeRotation,
      });
    })()`);
    const o = JSON.parse(out);
    const k = pdfkit(rotFile);
    if (!k) return 'skipped (PyObjC Quartz unavailable)';
    const stamp = k.annotations.find((x) => x.type === 'Stamp');
    assert(stamp, 'no /Stamp annotation in the saved file');
    const [rx, ry, rw, rh] = stamp.rect;
    const want = o.aabb;
    const got = [rx, ry, rx + rw, ry + rh];
    for (let i = 0; i < 4; i++) {
      assert(Math.abs(got[i] - want[i]) < 1.5,
        `saved bounding box ${got.map((v) => v.toFixed(1))} does not match ` +
        `the on-screen box ${want.map((v) => v.toFixed(1))}`);
    }
    return `on-screen box matches the saved /Rect within 1.5pt at ${o.rotation}°`;
  });

  // --- undo / redo ---------------------------------------------------------
  await check('undo and redo restore the annotation set exactly', async () => {
    const out = await js(`(() => {
      const A = window.__app, S = A.state;
      const before = S.annots.length;
      A.snapshot();
      S.annots.push({ id: A.uid(), page: 2, type: 'square', color: [1,0,0],
        strokeWidth: 2, rect: { x: 100, y: 100, w: 50, h: 50 } });
      const added = S.annots.length;
      A.undo();  const afterUndo = S.annots.length;
      A.redo();  const afterRedo = S.annots.length;
      A.undo();  const final = S.annots.length;
      return JSON.stringify({ before, added, afterUndo, afterRedo, final });
    })()`);
    const o = JSON.parse(out);
    assert(o.added === o.before + 1 && o.afterUndo === o.before &&
           o.afterRedo === o.before + 1 && o.final === o.before,
      `sequence was ${JSON.stringify(o)}`);
    return `${o.before} → ${o.added} → undo ${o.afterUndo} → redo ${o.afterRedo} → undo ${o.final}`;
  });

  await check('deleting a selected annotation removes exactly one', async () => {
    const out = await js(`(() => {
      const A = window.__app, S = A.state;
      const before = S.annots.length;
      S.selectedId = S.annots[0].id;
      A.deleteSelected();
      const after = S.annots.length;
      A.undo();
      return JSON.stringify({ before, after, restored: S.annots.length });
    })()`);
    const o = JSON.parse(out);
    assert(o.after === o.before - 1 && o.restored === o.before, JSON.stringify(o));
    return `${o.before} → ${o.after} → undo → ${o.restored}`;
  });

  // --- save ----------------------------------------------------------------
  const expected = JSON.parse(await js('JSON.stringify(window.__app.state.annots.length)'));

  await check('save writes the file', async () => {
    const out = await js(`(async () => {
      await window.__app.save(false);
      return JSON.stringify({ dirty: window.__app.state.dirty, path: window.__app.state.path });
    })()`);
    const o = JSON.parse(out);
    assert(!o.dirty, 'the document is still marked dirty after saving');
    assert(fs.existsSync(work), 'the target file does not exist');
    return `${expected} annotations → ${path.basename(o.path)}`;
  });

  await check('PDFKit sees every annotation in the saved file', async () => {
    const k = pdfkit(work);
    if (!k) return 'skipped (PyObjC Quartz unavailable)';
    assert(!k.error, k.error);
    assert(k.annotations.length === expected,
      `PDFKit found ${k.annotations.length}, the app saved ${expected}`);
    const types = [...new Set(k.annotations.map((a) => a.type))].sort();
    for (const t of ['Highlight', 'Underline', 'StrikeOut', 'Square', 'Circle',
                     'Line', 'Ink', 'FreeText', 'Text', 'Stamp']) {
      assert(types.includes(t), `no /${t} annotation in the saved file (got ${types})`);
    }
    return `${k.annotations.length} annotations: ${types.join(', ')}`;
  });

  await check('CoreGraphics paints the annotations in the saved file', async () => {
    const before = rasterize(path.join(FIX, 'plain.pdf'));
    const after = rasterize(work);
    const r = diffRatio(before, after);
    assert(r > 0.02, `only ${(r * 100).toFixed(2)}% of page 1 pixels changed`);
    return `${(r * 100).toFixed(1)}% of page 1 pixels changed`;
  });

  await check('the pasted image is visible in the saved file', async () => {
    const a = JSON.parse(await js(`JSON.stringify(
      window.__app.state.annots.find(x => x.type === 'image'))`));
    const img = rasterize(work);
    const fx = a.rect.x / 612, fy = (792 - (a.rect.y + a.rect.h)) / 792;
    const m = regionMean(img, fx, fy, a.rect.w / 612, a.rect.h / 792);
    const b = rasterize(path.join(FIX, 'plain.pdf'));
    const mb = regionMean(b, fx, fy, a.rect.w / 612, a.rect.h / 792);
    const delta = Math.abs(m[0] - mb[0]) + Math.abs(m[1] - mb[1]) + Math.abs(m[2] - mb[2]);
    assert(delta > 60, `image region barely changed (Δ${delta.toFixed(0)})`);
    return `Δ${delta.toFixed(0)} at rgb(${m.map((v) => v | 0)})`;
  });

  await check('saving twice does not duplicate annotations', async () => {
    await js('window.__app.save(false)');
    await wait(600);
    const k = pdfkit(work);
    if (!k) return 'skipped (PyObjC Quartz unavailable)';
    assert(k.annotations.length === expected,
      `after a second save PDFKit found ${k.annotations.length}, expected ${expected}`);
    return `still ${k.annotations.length} annotations after two saves`;
  });

  // --- reopen --------------------------------------------------------------
  await check('reopening the saved file shows the annotations', async () => {
    const out = await js(`(async () => {
      await window.__app.openDocument(await window.api.openPdf(${JSON.stringify(work)}));
      await new Promise(r => setTimeout(r, 1200));
      const A = window.__app, page = A.state.pages[0];
      // Marks the app can take over are drawn in the live overlay, and pdf.js
      // is told not to paint them as well -- otherwise every reopened mark
      // would render twice, once flat and once editable. So the evidence that
      // they came back is in the overlay, not in the page raster.
      const drawn = page.svg.querySelectorAll('[data-id]').length;
      const kinds = [...new Set(A.state.annots.map(a => a.type))].sort();
      return JSON.stringify({ annots: A.state.annots.length, drawn, kinds,
        readOnly: A.state.readOnlyMarks });
    })()`);
    const o = JSON.parse(out);
    assert(!o.readOnly, 'the reopened marks came back read-only');
    assert(o.annots > 0, 'reopening left no editable marks in memory');
    assert(o.drawn > 0, `${o.annots} marks in memory but nothing drawn in the overlay`);
    assert(o.kinds.includes('highlight'), `no highlight came back (got ${o.kinds.join(', ')})`);
    return `${o.annots} marks back as editable objects (${o.kinds.join(', ')}), ${o.drawn} drawn`;
  });

  // --- an encrypted original must never be overwritten ---------------------
  await check('an encrypted PDF is saved to a copy, leaving the original intact', async () => {
    const enc = path.join(FIX, 'encrypted.pdf');
    if (!fs.existsSync(enc)) return 'skipped (no encrypted fixture; needs PyObjC)';

    const original = path.join(TMP, 'secret.pdf');
    fs.copyFileSync(enc, original);
    const originalBytes = fs.readFileSync(original);
    const copy = path.join(TMP, 'secret (annotated).pdf');

    // Stand in for the Save panel. main.js calls this exact module object.
    const { dialog } = require('electron');
    const realSaveDialog = dialog.showSaveDialog;
    let sawMessage = null, sawDefault = null;
    dialog.showSaveDialog = async (_win, opts) => {
      sawMessage = opts.message; sawDefault = opts.defaultPath;
      return { canceled: false, filePath: copy };
    };

    try {
      const out = await js(`(async () => {
        const A = window.__app;
        await A.openDocument(await window.api.openPdf(${JSON.stringify(original)}));
        await new Promise(r => setTimeout(r, 900));
        A.state.annots.push({ id: A.uid(), page: 0, type: 'highlight',
          color: [1, 0.9, 0.2],
          quads: [[72, 692, 400, 692, 72, 676, 400, 676]] });
        A.state.dirty = true;
        // A plain Save -- the app must redirect it, not the test.
        await A.save(false);
        return JSON.stringify({ path: A.state.path, dirty: A.state.dirty });
      })()`);
      const o = JSON.parse(out);

      assert(sawMessage && /encrypted/i.test(sawMessage),
        `the Save panel did not explain why: ${sawMessage}`);
      assert(o.path === copy, `the app saved to ${o.path}, expected the copy`);
      assert(fs.readFileSync(original).equals(originalBytes),
        'the encrypted original was modified');
      assert(fs.existsSync(copy), 'no copy was written');

      const k = pdfkit(copy);
      if (k) {
        assert(k.annotations.some((a) => a.type === 'Highlight'),
          `the copy has no highlight (${k.annotations.map((a) => a.type)})`);
      }
      return `original untouched (${originalBytes.length} bytes), ` +
             `annotated copy written to ${path.basename(copy)}`;
    } finally {
      dialog.showSaveDialog = realSaveDialog;
    }
  });

  // --- odd geometry, through the real UI ----------------------------------
  // --- rotated + offset pages, measured against a PDFKit reference --------
  // The previous version of this check built its expectation with the same
  // toPdf() it was testing, so a whole-frame error was invisible to it. This
  // one compares our painted ink against a highlight PDFKit authored itself.
  for (const fixture of ['plain.pdf', 'rotated90.pdf', 'rotated270.pdf', 'cropoffset.pdf']) {
    await check(`${fixture}: our highlight lands where Preview puts it`, async () => {
      const src = path.join(FIX, fixture);
      const ours = path.join(TMP, 'ref-' + fixture);
      const ref = path.join(TMP, 'pdfkit-' + fixture);
      fs.copyFileSync(src, ours);

      if (!fs.existsSync(VENV)) return 'skipped (PyObjC Quartz unavailable)';
      const refOut = JSON.parse(execFileSync(VENV,
        [path.join(__dirname, 'pdfkit-highlight.py'), src, ref, 'Page 1'],
        { encoding: 'utf8' }));
      assert(!refOut.error, `PDFKit reference failed: ${refOut.error}`);

      const out = await js(`(async () => {
        const A = window.__app;
        await A.openDocument(await window.api.openPdf(${JSON.stringify(ours)}));
        await new Promise(r => setTimeout(r, 1200));
        const page = A.state.pages[0];
        const span = [...page.textLayerDiv.querySelectorAll('span')]
          .find(s => s.textContent.trim().startsWith('Page 1'));
        if (!span) return JSON.stringify({ error: 'no "Page 1" span' });
        A.setTool('highlight');
        const r = document.createRange();
        r.selectNodeContents(span);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        A.applyTextMarkup();
        if (!A.state.annots.length) return JSON.stringify({ error: 'no highlight made' });
        await A.save(false);
        return JSON.stringify({ ok: true });
      })()`);
      const o = JSON.parse(out);
      assert(!o.error, o.error);

      // Where did each file actually put yellow ink?
      const inkBox = (file) => {
        const img = rasterize(file, 1000);
        let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            const off = (y * img.width + x) * img.channels;
            const [r, g, b] = [img.data[off], img.data[off + 1], img.data[off + 2]];
            if (r > 120 && g > 100 && b < Math.min(r, g) - 45) {
              n++;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        return n ? { x0: x0 / img.width, x1: x1 / img.width,
                     y0: y0 / img.height, y1: y1 / img.height, n } : null;
      };
      const a = inkBox(ref), b = inkBox(ours);
      assert(a, 'the PDFKit reference painted no highlight');
      assert(b, 'our highlight painted nothing');
      const overlaps = b.x0 < a.x1 && b.x1 > a.x0 && b.y0 < a.y1 && b.y1 > a.y0;
      assert(overlaps,
        `our ink sits at x ${(b.x0 * 100).toFixed(1)}-${(b.x1 * 100).toFixed(1)}% ` +
        `y ${(b.y0 * 100).toFixed(1)}-${(b.y1 * 100).toFixed(1)}% but Preview's is at ` +
        `x ${(a.x0 * 100).toFixed(1)}-${(a.x1 * 100).toFixed(1)}% ` +
        `y ${(a.y0 * 100).toFixed(1)}-${(a.y1 * 100).toFixed(1)}%`);
      // and they should be in substantially the same place, not merely touching
      const dx = Math.abs(b.x0 - a.x0), dy = Math.abs(b.y0 - a.y0);
      assert(dx < 0.03 && dy < 0.03,
        `corner off by ${(dx * 100).toFixed(1)}%, ${(dy * 100).toFixed(1)}% of the page`);
      return `ink at x ${(b.x0 * 100).toFixed(1)}-${(b.x1 * 100).toFixed(1)}%, ` +
             `Preview's at ${(a.x0 * 100).toFixed(1)}-${(a.x1 * 100).toFixed(1)}%`;
    });
  }

  // --- the fixes the QA pass asked for -------------------------------------
  await check('undo back to a clean document lets the window close', async () => {
    const f = path.join(TMP, 'undo-clean.pdf');
    fs.copyFileSync(path.join(FIX, 'plain.pdf'), f);
    const out = await js(`(async () => {
      const A = window.__app;
      await A.openDocument(await window.api.openPdf(${JSON.stringify(f)}));
      await new Promise(r => setTimeout(r, 800));
      A.snapshot();
      A.state.annots.push({ id: A.uid(), page: 0, type: 'square', color: [1,0,0],
        strokeWidth: 2, rect: { x: 100, y: 100, w: 80, h: 60 } });
      A.redrawAll();
      const dirtyAfterDraw = A.state.dirty;
      A.undo();
      const t0 = Date.now();
      await A.save(false);
      return JSON.stringify({ dirtyAfterDraw, annots: A.state.annots.length,
        dirty: A.state.dirty, ms: Date.now() - t0 });
    })()`);
    const o = JSON.parse(out);
    assert(o.dirtyAfterDraw, 'drawing did not mark the document dirty');
    assert(o.annots === 0, `undo left ${o.annots} annotations`);
    assert(!o.dirty, 'still dirty after saving an emptied document');
    assert(o.ms < 5000, `the save took ${o.ms}ms`);
    return `draw → undo → save clears dirty in ${o.ms}ms`;
  });

  await check('a note is drawn exactly where it is saved', async () => {
    const out = await js(`(() => {
      const A = window.__app, page = A.state.pages[0];
      A.snapshot();
      const a = { id: A.uid(), page: 0, type: 'note', color: [1,0.85,0.3],
        rect: { x: 100, y: 400, w: 20, h: 20 }, text: 'x' };
      A.state.annots.push(a);
      A.redrawAll();
      const b = A.viewBox(page, a);
      const p0 = page.viewport.convertToPdfPoint(b.x, b.y + b.h);
      const p1 = page.viewport.convertToPdfPoint(b.x + b.w, b.y);
      A.state.annots.pop();
      A.redrawAll();
      return JSON.stringify({ x0: Math.min(p0[0],p1[0]), x1: Math.max(p0[0],p1[0]),
                              y0: Math.min(p0[1],p1[1]), y1: Math.max(p0[1],p1[1]) });
    })()`);
    const o = JSON.parse(out);
    // the writer emits [x, y-20, x+20, y] = [100, 380, 120, 400]
    assert(Math.abs(o.x0 - 100) < 1 && Math.abs(o.x1 - 120) < 1 &&
           Math.abs(o.y0 - 380) < 1 && Math.abs(o.y1 - 400) < 1,
      `drawn at ${[o.x0, o.y0, o.x1, o.y1].map((v) => v.toFixed(1))}, ` +
      `saved as 100,380,120,400`);
    return `drawn box matches the saved /Rect`;
  });

  await check('the stroke-width control is undoable and marks the document dirty', async () => {
    const out = await js(`(() => {
      const A = window.__app;
      A.state.annots.push({ id: 'sw', page: 0, type: 'square', color: [1,0,0],
        strokeWidth: 2, rect: { x: 50, y: 50, w: 40, h: 40 } });
      A.state.selectedId = 'sw';
      A.state.dirty = false;
      A.redrawAll();
      const depth = A.state.undo.length;
      const btn = document.querySelector('[data-stroke="2"]');
      btn.click();
      const a = A.state.annots.find(x => x.id === 'sw');
      return JSON.stringify({ width: a.strokeWidth, dirty: A.state.dirty,
        added: A.state.undo.length - depth });
    })()`);
    const o = JSON.parse(out);
    assert(o.width > 2, `width is ${o.width}`);
    assert(o.dirty, 'changing stroke width did not mark the document dirty');
    assert(o.added === 1, `added ${o.added} undo entries, expected exactly 1`);
    return `width → ${o.width.toFixed(1)}, dirty set, one undo entry`;
  });

  await check('an annotation cannot be dragged off the page', async () => {
    const out = await js(`(() => {
      const A = window.__app, page = A.state.pages[0];
      const a = A.state.annots.find(x => x.id === 'sw');
      const lim = A.pageLimits(page);
      const orig = { rect: { ...a.rect } };
      const [dx, dy] = (() => {
        const f = A.annotBounds({ ...a, ...orig });
        return [0, 0];
      })();
      // simulate a huge upward drag through the same clamp the drag uses
      A.state.selectedId = a.id;
      const r = page.canvas.getBoundingClientRect();
      const hit = [...page.svg.querySelectorAll('.hit.movable')]
        .find(el => el.dataset.id === a.id);
      const c = hit.getBoundingClientRect();
      const from = [c.left + c.width / 2, c.top + c.height / 2];
      hit.dispatchEvent(new PointerEvent('pointerdown', { clientX: from[0],
        clientY: from[1], button: 0, buttons: 1, bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from[0],
        clientY: from[1] - 5000, button: 0, buttons: 1, bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: from[0],
        clientY: from[1] - 5000, button: 0, buttons: 1, bubbles: true, pointerId: 1 }));
      const after = A.state.annots.find(x => x.id === 'sw');
      const b = A.annotBounds(after);
      return JSON.stringify({ b, lim });
    })()`);
    const o = JSON.parse(out);
    assert(o.b.y1 <= o.lim.y1 + 0.5 && o.b.y0 >= o.lim.y0 - 0.5,
      `annotation ended at y ${o.b.y0.toFixed(0)}..${o.b.y1.toFixed(0)} ` +
      `on a page spanning ${o.lim.y0}..${o.lim.y1}`);
    return `clamped to the page (y ${o.b.y0.toFixed(0)}..${o.b.y1.toFixed(0)})`;
  });

  // --- report --------------------------------------------------------------
  console.log('');
  for (const [status, name, detail] of log) {
    const tag = status === 'PASS' ? '\x1b[32m PASS \x1b[0m'
      : status === 'SKIP' ? '\x1b[33m SKIP \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
    console.log(`${tag} ${name}${detail ? '  \x1b[90m-- ' + detail + '\x1b[0m' : ''}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`artifacts: ${TMP}`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => {
  run().catch((e) => {
    console.error('\nUI harness crashed:', e);
    app.exit(2);
  });
});
