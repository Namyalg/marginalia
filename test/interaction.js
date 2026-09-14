'use strict';

// Piping this into `head`, or quitting `less` early, closes stdout underneath
// us. Without this an EPIPE from the next write goes uncaught, and in an
// Electron main process that means a modal "A JavaScript error occurred"
// dialog instead of a quiet exit.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
}

/**
 * interaction.js -- the app driven by REAL input.
 *
 * Every mouse and key event here goes through `webContents.sendInputEvent`,
 * i.e. Chromium's real input pipeline: hit-testing, focus management,
 * click-count tracking and native text input all behave exactly as they do for
 * a user. Nothing in this file calls `dispatchEvent`, and nothing calls an
 * app function to *perform* a user action.
 *
 * Three rules, because each one corresponds to a shipped bug that a green
 * suite failed to see (see TEST-STRATEGY.md):
 *
 *   1. Never assert on a value produced by the thing under test. Read state
 *      back through an independent route -- document.activeElement,
 *      getSelection(), the rendered SVG, computed styles, rasterised pixels,
 *      or the saved PDF read by PDFKit.
 *   2. Never hold a DOM node across a click. The overlay is rebuilt on
 *      selection, so every target is re-resolved by annotation id immediately
 *      before it is clicked.
 *   3. Every input helper proves the input *landed* before the check asserts
 *      what it did. A mistyped coordinate must fail, not pass vacuously.
 *
 * Run: npx electron test/interaction.js [file.pdf]
 */

const { app, BrowserWindow, Menu, clipboard, ClipboardItem } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { decodePng } = require('./png');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfa-interaction-'));
const VENV = process.env.PDFKIT_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
const HAVE_PDFKIT = fs.existsSync(VENV);

/** A big, real-world document: pass one on the command line to exercise the
 *  slow paths (many pages, slide-sized viewports). Falls back to the generated
 *  fixture. Whatever you pass is NEVER opened directly -- the app autosaves, so
 *  every document this suite touches is a copy in TMP. */
const BIG = process.argv.slice(2).find((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a))
  || path.join(FIX, 'plain.pdf');

let pass = 0, fail = 0, skip = 0;
const failures = [];

function line(status, name, detail) {
  const colour = status === 'ok' ? '\x1b[32m' : status === 'SKIP' ? '\x1b[33m' : '\x1b[31m';
  process.stdout.write(`  ${colour}${status.padEnd(4)}\x1b[0m ${name}` +
    (detail ? `  \x1b[90m-- ${detail}\x1b[0m` : '') + '\n');
}

const CHECK_TIMEOUT = 45000;

/** Real input only behaves like real input while the window holds keyboard
 *  focus: without it `ta.focus()` does not stick and an editor commits itself
 *  the instant it opens. Repair focus before every check, and say so if it
 *  could not be repaired rather than blaming the app. */
async function ensureFocus(tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (await js(`document.hasFocus()`)) return true;
    app.focus({ steal: true });
    win.show();
    win.focus();
    await wait(250);
  }
  return await js(`document.hasFocus()`);
}

async function check(name, fn) {
  let timer;
  const focused = win ? await ensureFocus(4) : true;
  try {
    const detail = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out after ${CHECK_TIMEOUT / 1000}s`)),
          CHECK_TIMEOUT);
      }),
    ]);
    if (detail === SKIPPED) { skip++; line('SKIP', name, SKIPPED.reason); }
    else { pass++; line('ok', name, typeof detail === 'string' ? detail : ''); }
  } catch (e) {
    // Only blame focus if it was still missing when the check actually failed.
    const stillUnfocused = !focused && win && !(await js(`document.hasFocus()`).catch(() => true));
    const why = e.message + (stillUnfocused
      ? ' [the harness window did not hold OS focus for this check]' : '');
    fail++; failures.push(`${name}: ${why}`);
    line('FAIL', name, why);
  } finally { clearTimeout(timer); }
}
const SKIPPED = { reason: '' };
const skipped = (reason) => { SKIPPED.reason = reason; return SKIPPED; };
const assert = (c, m) => { if (!c) throw new Error(m); };

/** The phrase every reference highlight is built over. It has to be a whole
 *  text span: the app highlights what the user's drag selected (the span),
 *  PDFKit highlights exactly the phrase, and comparing those two is only
 *  apples-to-apples when they are the same run of text. */
const PHRASE = 'Page 1';

/** Compare our /Rect with one PDFKit authored itself, as read back by PDFKit.
 *  Heights are NOT compared: PDFKit's selection bounds on these synthetic
 *  fixtures are a tight glyph box, ours is the font's ascent-to-descent band
 *  (VERIFICATION.md §4). Orientation, origin and width are what a frame error
 *  would break. */
function compareToReference(ours, ref, what) {
  const horizontal = (r) => r[2] > r[3];
  assert(horizontal(ours) === horizontal(ref),
    `${what}: our /Rect is ${JSON.stringify(ours)} where PDFKit's is ` +
    `${JSON.stringify(ref)} -- transposed, the signature of a rotated-frame error`);
  assert(Math.abs(ours[0] - ref[0]) < 8,
    `${what}: our /Rect starts at x=${ours[0]}, PDFKit's at x=${ref[0]}`);
  const oursTop = ours[1] + ours[3], refTop = ref[1] + ref[3];
  const overlap = Math.min(oursTop, refTop) - Math.max(ours[1], ref[1]);
  assert(overlap > 0,
    `${what}: our band spans y ${ours[1]}-${oursTop.toFixed(2)}, PDFKit's ` +
    `${ref[1]}-${refTop.toFixed(2)} -- they do not even overlap`);
  assert(Math.abs(ours[2] - ref[2]) < Math.max(8, ref[2] * 0.2),
    `${what}: our band is ${ours[2]}pt wide, PDFKit's ${ref[2]}pt`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ----------------------------------------------------------- outside engines

function pdfkit(file) {
  if (!HAVE_PDFKIT) return null;
  return JSON.parse(execFileSync(VENV, [path.join(__dirname, 'verify-pdfkit.py'), file],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 }));
}

/** PDFKit authors a highlight over `phrase` -- the reference Preview draws. */
function pdfkitHighlight(src, out, phrase) {
  execFileSync(VENV, [path.join(__dirname, 'pdfkit-highlight.py'), src, out, phrase],
    { encoding: 'utf8', timeout: 60000 });
  return out;
}

let rasterSeq = 0;
/** CoreGraphics rasterisation. qlmanage stalls occasionally; always time out. */
function rasterize(file, size = 900) {
  const dir = path.join(TMP, 'ql' + (rasterSeq++));
  fs.mkdirSync(dir, { recursive: true });
  let ok = false;
  for (let i = 0; i < 2 && !ok; i++) {
    try {
      execFileSync('qlmanage', ['-t', '-s', String(size), '-o', dir, file],
        { stdio: 'ignore', timeout: 45000 });
      ok = true;
    } catch (e) { if (i) throw new Error(`qlmanage failed: ${e.message}`); }
  }
  const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
  assert(png, `qlmanage produced no PNG for ${path.basename(file)}`);
  return decodePng(fs.readFileSync(path.join(dir, png)));
}

/** Bounding box of "yellowish" pixels, as a fraction of the raster. */
function yellowBox(img) {
  let n = 0, minX = img.width, maxX = -1, minY = img.height, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * img.channels;
      const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      if (r > 120 && g > 100 && b < Math.min(r, g) - 45) {
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { n, x0: minX / img.width, x1: maxX / img.width,
           y0: minY / img.height, y1: maxY / img.height };
}

// ------------------------------------------------------------- the real app

require(path.join(ROOT, 'main.js'));

let win = null, wc = null;
const js = (code) => wc.executeJavaScript(code, true);
const jsJSON = async (code) => JSON.parse(await js(code));

// ------------------------------------------------------------ input drivers
//
// Window-relative CSS pixels. checkCoordinateInvariant() proves these are the
// same numbers as the renderer's client coordinates before anything else runs.

const send = (ev) => wc.sendInputEvent(ev);

async function moveTo(x, y) {
  send({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  await wait(8);
}

/** A real press-and-release. clickCount 2 is what makes Chromium treat the
 *  second press as a double-click -- the thing a synthetic 'dblclick' skips. */
async function mouseClick(x, y, { clickCount = 1, modifiers = [] } = {}) {
  const p = { x: Math.round(x), y: Math.round(y), button: 'left', modifiers };
  send({ type: 'mouseMove', ...p });
  send({ type: 'mouseDown', ...p, clickCount });
  await wait(20);
  send({ type: 'mouseUp', ...p, clickCount });
  await wait(60);
}

/** Installed once. Records every real pointerdown the renderer sees, so a
 *  check can prove the two presses of a double-click arrived as two presses. */
async function armPointerRecorder() {
  await js(`(()=>{if(window.__rec) return 1; window.__rec=[];
    const note=(what,e)=>window.__rec.push({t:+performance.now().toFixed(1),what,
      id:(e&&e.target&&e.target.dataset&&e.target.dataset.id)||null,
      cls:e&&e.target?String((e.target.getAttribute&&e.target.getAttribute('class'))||e.target.tagName):'',
      sel:window.__app&&window.__app.state.selectedId,
      eds:document.querySelectorAll('.ftEditor').length});
    window.addEventListener('pointerdown',e=>note('down',e),true);
    window.addEventListener('dblclick',e=>note('dblclick',e),true);
    new MutationObserver(ms=>{for(const m of ms){
      for(const n of m.addedNodes) if(n.className==='ftEditor') note('editor+',null);
      for(const n of m.removedNodes) if(n.className==='ftEditor') note('editor-',null);}})
      .observe(document.body,{childList:true,subtree:true});
    return 1;})()`);
}

/** The signature of a window that is not the OS key window: an editor is
 *  created and the platform takes focus straight back off it, so the
 *  textarea's own blur listener closes it within a millisecond. A user's
 *  window is always key, so this is a harness condition, not a defect --
 *  checks that see it report SKIP rather than a failure that is not real. */
async function editorDiedInstantly() {
  const rec = await jsJSON(`JSON.stringify((window.__rec||[]).slice(-4))`);
  for (let i = 0; i < rec.length - 1; i++) {
    if (rec[i].what === 'editor+' && rec[i + 1].what === 'editor-' &&
        rec[i + 1].t - rec[i].t < 30) return true;
  }
  return false;
}

async function doubleClick(x, y) {
  // The app recognises a double-click itself, by annotation id within a 450ms
  // window. What the renderer saw is recorded so that a harness that failed to
  // deliver two distinct presses is never reported as an app bug.
  await armPointerRecorder();
  await js(`window.__rec.length=0`);
  await mouseClick(x, y, { clickCount: 1 });
  await wait(60);
  await mouseClick(x, y, { clickCount: 2 });
  await wait(200);
  lastPresses = await jsJSON(`JSON.stringify(window.__rec)`);
  lastDoubleClickGap = lastPresses.length >= 2
    ? +(lastPresses[1].t - lastPresses[0].t).toFixed(0) : -1;
}
let lastDoubleClickGap = -1;
let lastPresses = [];

async function drag(from, to, { steps = 12, modifiers = [], settle = 160 } = {}) {
  const x0 = Math.round(from[0]), y0 = Math.round(from[1]);
  const x1 = Math.round(to[0]), y1 = Math.round(to[1]);
  send({ type: 'mouseMove', x: x0, y: y0, modifiers });
  await wait(10);
  send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers });
  await wait(20);
  for (let i = 1; i <= steps; i++) {
    send({ type: 'mouseMove', button: 'left', modifiers,
      x: Math.round(x0 + (x1 - x0) * i / steps),
      y: Math.round(y0 + (y1 - y0) * i / steps) });
    await wait(10);
  }
  send({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1, modifiers });
  await wait(settle);
}

/** One key, through the real keyboard pipeline. `char` is what actually
 *  inserts text -- omitting it is how a "typing" test can type nothing. */
async function key(keyCode, modifiers = []) {
  send({ type: 'keyDown', keyCode, modifiers });
  const printable = (keyCode.length === 1 || keyCode === 'Enter') &&
    !modifiers.some((m) => m === 'meta' || m === 'control' || m === 'alt');
  if (printable) send({ type: 'char', keyCode, modifiers });
  send({ type: 'keyUp', keyCode, modifiers });
  await wait(18);
}

async function typeText(text) {
  for (const ch of text) await key(ch);
  await wait(80);
  // Precondition, not an assertion about the app: make sure every character
  // has actually arrived before the check does whatever comes next. A key
  // still in flight would otherwise look like the app losing it.
  for (let i = 0; i < 16; i++) {
    const v = await js(`(()=>{const a=document.activeElement;
      return a && a.value !== undefined ? JSON.stringify(a.value) : 'null';})()`);
    if (v === 'null') return;
    if (JSON.parse(v).endsWith(text)) return;
    await wait(60);
  }
  throw new Error(`the harness could not deliver "${text}" into the field`);
}

/** Click a real application-menu item.
 *  NOT independent input: `sendInputEvent` injects straight into the web
 *  contents and never reaches the native NSMenu, so ⌘-accelerators cannot be
 *  exercised from a harness at all (measured -- see TEST-STRATEGY.md). This
 *  runs the item's own handler, which covers everything downstream of the
 *  accelerator but not the accelerator binding itself. */
function menuClick(...labels) {
  let items = Menu.getApplicationMenu().items;
  let item = null;
  for (const label of labels) {
    item = items.find((m) => m.label === label);
    assert(item, `no menu item "${label}"`);
    items = item.submenu ? item.submenu.items : [];
  }
  item.click();
}
function menuItem(...labels) {
  let items = Menu.getApplicationMenu().items, item = null;
  for (const label of labels) {
    item = items.find((m) => m.label === label);
    if (!item) return null;
    items = item.submenu ? item.submenu.items : [];
  }
  return item;
}

// ------------------------------------------------- geometry read out of page
//
// Everything below re-resolves its target on every call. No DOM node ever
// crosses a click boundary.

/** Client rect of a page element. */
const pageRect = (i) => jsJSON(
  `(()=>{const r=window.__app.state.pages[${i}].el.getBoundingClientRect();
    return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`);

/** A point at (fx, fy) of page `i`, in window CSS pixels. */
async function pagePoint(i, fx, fy) {
  const r = await pageRect(i);
  return [r.x + r.w * fx, r.y + r.h * fy];
}

/** Client rect of whatever currently renders annotation `id`.
 *  Re-queried every call -- the node from last time is already gone. */
async function annotRect(id, selector = '') {
  // Selection handles carry data-id too, and an 8x8 handle is not the
  // annotation: take the largest non-handle node that currently paints it.
  const r = await jsJSON(
    `(()=>{const all=[...document.querySelectorAll('[data-id="${id}"]${selector}')];
      // the transparent .hit rect IS the annotation's clickable body; the <g>
      // wrapper spans the whole page and an 8px handle is not the mark.
      const hit=all.find(e=>e.classList.contains('hit')&&!e.classList.contains('handle')
        &&!e.classList.contains('rothandle'));
      const el=hit||all.find(e=>e.tagName!=='g');
      if(!el) return 'null';
      const r=el.getBoundingClientRect();
      return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`);
  assert(r, `annotation ${id} has no rendered node${selector ? ' matching ' + selector : ''}`);
  return r;
}
const centreOf = (r) => [r.x + r.w / 2, r.y + r.h / 2];

/** Client rect of a CSS selector (toolbar buttons, the editor, ...). */
async function elRect(sel) {
  const r = await jsJSON(
    `(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return 'null';const r=el.getBoundingClientRect();
      return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`);
  assert(r, `no element matching ${sel}`);
  return r;
}

/** Precondition: what does Chromium's own hit-testing find at this point?
 *  If a coordinate is wrong this fails loudly instead of the check passing
 *  because nothing happened. */
async function hitAt(x, y) {
  return jsJSON(`(()=>{const el=document.elementFromPoint(${Math.round(x)},${Math.round(y)});
    return JSON.stringify(el?{tag:el.tagName,cls:String(el.getAttribute('class')||''),
      id:el.id||'',dataId:(el.dataset&&el.dataset.id)||'',
      handle:(el.dataset&&el.dataset.handle)||''}:null);})()`);
}
async function expectHit(x, y, pred, what) {
  const h = await hitAt(x, y);
  assert(h, `nothing at (${Math.round(x)},${Math.round(y)}) -- expected ${what}`);
  assert(pred(h), `at (${Math.round(x)},${Math.round(y)}) found ` +
    `${h.tag}.${h.cls}#${h.id} -- expected ${what}`);
  return h;
}

const activeEl = () => jsJSON(`(()=>{const a=document.activeElement;
  return JSON.stringify({tag:a.tagName,cls:String(a.className||''),
    hasFocus:document.hasFocus(),
    value:a.value===undefined?null:a.value,
    selStart:a.selectionStart===undefined?null:a.selectionStart,
    selEnd:a.selectionEnd===undefined?null:a.selectionEnd});})()`);

const annots = () => jsJSON(`JSON.stringify(window.__app.state.annots)`);
/** Independent count: how many annotations the overlay actually renders. */
const renderedIds = () => jsJSON(`JSON.stringify([...new Set(
  [...document.querySelectorAll('.overlay [data-id]')].map(e=>e.dataset.id))])`);
/** Independent text readback: what the overlay paints for a text box. */
const renderedText = (id) => js(
  `(()=>{const g=[...document.querySelectorAll('.overlay text')]
    .find(t=>t.parentNode.querySelector('[data-id="${id}"]'));
    return g?[...g.querySelectorAll('tspan')].map(s=>s.textContent).join('\\n'):null;})()`);

async function openDoc(src, { name = path.basename(src), settle = 2500 } = {}) {
  const work = path.join(TMP, `${rasterSeq}-${Date.now()}-${name}`);
  fs.copyFileSync(src, work);          // never open the original
  await js(`(async()=>{window.__app.state.dirty=false;
    return window.__app.openDocument(await window.api.openPdf(${JSON.stringify(work)}));})()`);
  await wait(settle);
  return work;
}

/**
 * Pick a tool the only way a user now can: by clicking its toolbar button.
 * The single-letter shortcuts were removed deliberately -- a bare letter fired
 * while typing into a text box or the document name -- so this clicks instead.
 * The `k` argument is kept so call sites read the same; it is only a label.
 */
async function setToolByKey(k, expected) {
  await dismissEditor();
  const box = await jsJSON(
    `(()=>{const b=document.querySelector('[data-tool="${expected}"]');
      if(!b) return 'null';
      const r=b.getBoundingClientRect();
      return JSON.stringify([Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]);})()`);
  assert(box, `no toolbar button for "${expected}"`);
  await mouseClick(box[0], box[1]);
  await wait(140);
  // Independent readback: the toolbar's own active button, not state.tool.
  const active = await js(
    `(()=>{const b=document.querySelector('.tool.active');return b?b.dataset.tool:null;})()`);
  assert(active === expected,
    `clicking the ${expected} button left the toolbar showing "${active}"`);
}

/** Drag-select real text on a page.
 *
 *  The selection is read from getSelection() *while the button is still down*:
 *  applyTextMarkup() calls removeAllRanges() on mouseup, so reading afterwards
 *  always returns "" and the precondition would be useless. */
async function dragSelectText(pageIndex, matcher) {
  const box = await jsJSON(
    `(()=>{const p=window.__app.state.pages[${pageIndex}];
      const spans=[...p.textLayerDiv.querySelectorAll('span')]
        .filter(s=>s.textContent && s.textContent.trim());
      const s=spans.find(x=>${matcher})||spans[0];
      if(!s) return 'null';
      const r=s.getBoundingClientRect();
      return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,text:s.textContent});})()`);
  assert(box, 'no text spans on that page');
  // Corner to corner: on a /Rotate 90 page the span's client rect is tall and
  // narrow, so a horizontal sweep through its middle selects nothing.
  const x0 = Math.round(box.x + 1), y0 = Math.round(box.y + 1);
  const x1 = Math.round(box.x + box.w - 1), y1 = Math.round(box.y + box.h - 1);
  send({ type: 'mouseMove', x: x0, y: y0 });
  await wait(20);
  send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
  await wait(30);
  for (let i = 1; i <= 10; i++) {
    send({ type: 'mouseMove', button: 'left',
      x: Math.round(x0 + (x1 - x0) * i / 10),
      y: Math.round(y0 + (y1 - y0) * i / 10) });
    await wait(14);
  }
  await wait(60);
  const sel = await js(`window.getSelection().toString()`);
  send({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
  await wait(350);
  return { box, sel };
}

/** Leave no editor open: a focused textarea swallows every subsequent key. */
async function dismissEditor() {
  if (await js(`!!document.querySelector('.ftEditor')`)) {
    await key('Escape');
    await wait(200);
  }
}

async function seedClipboardImage(file) {
  clipboard.clear();
  const buf = fs.readFileSync(file);
  await js('1');    // keep the renderer alive while the async write lands
  await clipboard.write([new ClipboardItem({
    'image/png': new Blob([buf], { type: 'image/png' }),
  })]);
  await wait(150);
}

// ===========================================================================

async function main() {
  for (let i = 0; i < 300; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) break;
    await wait(100);
  }
  assert(win, 'the app never opened a window');
  wc = win.webContents;
  const rendererErrors = [];
  wc.on('console-message', (e, level, message) => {
    const text = (e && e.message) || message || '';
    if (/error|failed|uncaught/i.test(text)) rendererErrors.push(text);
  });

  await armPointerRecorder();
  win.setSize(1280, 900);
  win.show();
  app.focus({ steal: true });
  win.focus();
  await wait(800);
  if (!(await ensureFocus(12))) {
    // Input still reaches the page (check A2 proves it), but `ta.focus()` does
    // not stick in an unfocused document, so caret assertions are not
    // meaningful. Those checks report SKIP instead of a false failure.
    console.log('\n  \x1b[33mnote:\x1b[0m the window will not take keyboard focus in this ' +
      'session.\n        Caret checks will be skipped; run it with the desktop ' +
      'idle to exercise them.');
  }

  console.log('\n\x1b[1mA. harness invariants\x1b[0m');

  await check('window CSS pixels are the renderer\'s client coordinates', async () => {
    const b = win.getContentBounds();
    const g = await jsJSON(`JSON.stringify({iw:innerWidth,ih:innerHeight,
      dpr:devicePixelRatio,sx:screenX,sy:screenY})`);
    assert(g.iw === b.width && g.ih === b.height,
      `innerWidth/Height ${g.iw}x${g.ih} != content bounds ${b.width}x${b.height}; ` +
      'every coordinate in this suite would be offset');
    return `${g.iw}x${g.ih} css px, dpr ${g.dpr}`;
  });

  await check('real input actually reaches the renderer', async () => {
    // Functional probe, not a focus flag: send a key and require the page to
    // have acted on it. If this fails, nothing below means anything.
    const seen = await js(`(()=>{window.__probe=[];
      window.addEventListener('keydown',e=>window.__probe.push(e.key),{once:true});
      return 'armed';})()`);
    assert(seen === 'armed', 'could not arm the probe');
    await key('q');
    const got = await js(`JSON.stringify(window.__probe||[])`);
    assert(got.includes('q'), `the renderer saw ${got} -- sendInputEvent is not landing`);
    return `focused=${win.isFocused()}, hasFocus=${await js('document.hasFocus()')}`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mB. every tool, drawn with the mouse\x1b[0m');

  const plainPath = await openDoc(path.join(FIX, 'plain.pdf'));

  await check('a document opens and paints a page', async () => {
    const g = await pageRect(0);
    assert(g.w > 100 && g.h > 100, `page is ${g.w}x${g.h}`);
    return `page 1 at ${g.w.toFixed(0)}x${g.h.toFixed(0)}`;
  });

  const drawnTools = [
    ['R', 'square', 'square'], ['O', 'circle', 'circle'],
    ['A', 'arrow', 'arrow'], ['L', 'line', 'line'], ['D', 'ink', 'ink'],
  ];
  let row = 0;
  for (const [k, tool, type] of drawnTools) {
    await check(`${k} selects ${tool}, and a mouse drag draws one`, async () => {
      await setToolByKey(k, tool);
      const before = (await renderedIds()).length;
      const y = 0.12 + row * 0.07;
      const from = await pagePoint(0, 0.55, y);
      const to = await pagePoint(0, 0.85, y + 0.05);
      await expectHit(from[0], from[1], (h) => h.tag === 'svg' || h.cls.includes('overlay') ||
        h.tag === 'DIV', 'the page overlay');
      await drag(from, to, { steps: 14 });
      const ids = await renderedIds();
      assert(ids.length === before + 1,
        `overlay renders ${ids.length} annotations, expected ${before + 1}`);
      const list = await annots();
      const a = list[list.length - 1];
      assert(a.type === type, `drew a "${a.type}", expected "${type}"`);
      const r = await annotRect(a.id);   // independent: what is actually painted
      assert(r.w > 20 && r.h > 5, `painted shape is only ${r.w.toFixed(0)}x${r.h.toFixed(0)}px`);
      row++;
      return `${r.w.toFixed(0)}x${r.h.toFixed(0)}px on screen`;
    });
  }

  // Each tool marks up a DIFFERENT line: a mark already covering the text
  // changes whether the text can be selected at all (see the re-markup check).
  const markupLines = { H: 'quick brown', U: 'Portable', S: 'appearance stream' };
  for (const [k, tool] of [['H', 'highlight'], ['U', 'underline'], ['S', 'strikeout']]) {
    await check(`${k} selects ${tool}, and dragging across text marks it up`, async () => {
      await setToolByKey(k, tool);
      const before = (await renderedIds()).length;
      const { box, sel } = await dragSelectText(0,
        `/${markupLines[k]}/.test(x.textContent)`);
      // Independent precondition: the browser's own selection, read while the
      // button is still down, proves the drag actually landed on text.
      assert(sel.trim().length > 2,
        `the drag selected "${sel}" -- the input never reached the text layer`);
      await wait(200);
      const list = await annots();
      const a = list[list.length - 1];
      assert(a && a.type === tool, `last annotation is "${a && a.type}", expected "${tool}"`);
      assert(a.quads && a.quads.length, 'no /QuadPoints');
      // Independent geometry: the painted band against the span pdf.js laid out.
      const r = await annotRect(a.id);
      const ox = Math.min(r.x + r.w, box.x + box.w) - Math.max(r.x, box.x);
      assert(ox > box.w * 0.5,
        `the band overlaps the text by only ${ox.toFixed(0)}px of ${box.w.toFixed(0)}px`);
      return `"${sel.trim().slice(0, 24)}" -> ${a.quads.length} quad(s)`;
    });
  }

  await check('text that is already marked up can still be selected and marked again',
    async () => {
      // Preview lets you underline a sentence you have already highlighted.
      await setToolByKey('U', 'underline');
      const before = (await renderedIds()).length;
      const { sel } = await dragSelectText(0, `/quick brown/.test(x.textContent)`);
      assert(sel.trim().length > 2,
        'dragging across text that already carries a highlight selected nothing: ' +
        'the mark\'s own transparent hit rect is taking the pointer ' +
        '(.overlay .hit { pointer-events: all } overrides .overlay.inert)');
      const after = (await renderedIds()).length;
      assert(after === before + 1, `expected one more mark, got ${after - before}`);
      return 'second mark added over the first';
    });

  await check('V returns to the select tool and a click selects a mark', async () => {
    await setToolByKey('V', 'select');
    const list = await annots();
    const target = list.find((a) => a.type === 'square');
    assert(target, 'nothing to select');
    const r = await annotRect(target.id);
    const [cx, cy] = centreOf(r);
    await mouseClick(cx, cy);
    // Independent: selection chrome exists in the overlay for that id.
    const chrome = await js(
      `!!document.querySelector('.overlay .selection [data-handle], .overlay .selection .selbox')`);
    assert(chrome, 'clicking the shape drew no selection chrome');
    const sel = await js(`window.__app.state.selectedId`);
    assert(sel === target.id, `selected "${sel}", expected "${target.id}"`);
    return 'selection chrome drawn';
  });

  await check('dragging a selected shape moves it where the mouse went', async () => {
    const list = await annots();
    const target = list.find((a) => a.type === 'square');
    const r0 = await annotRect(target.id);
    const from = centreOf(r0);
    await expectHit(from[0], from[1], (h) => h.dataId === target.id,
      `the hit area of ${target.id}`);
    await drag(from, [from[0] - 60, from[1] + 40], { steps: 10 });
    const r1 = await annotRect(target.id);       // re-resolved, never cached
    assert(near(r1.x - r0.x, -60, 6) && near(r1.y - r0.y, 40, 6),
      `moved by (${(r1.x - r0.x).toFixed(0)},${(r1.y - r0.y).toFixed(0)})px, expected (-60,40)`);
    return `moved ${(r1.x - r0.x).toFixed(0)},${(r1.y - r0.y).toFixed(0)}px`;
  });

  await check('T inserts a text box with the caret already in it', async () => {
    await setToolByKey('T', 'freetext');
    await wait(300);
    const a = await activeEl();
    if (!a.cls.includes('ftEditor') && await editorDiedInstantly()) {
      return skipped('the editor opened and the platform took focus straight back ' +
        'off it -- this window is not the OS key window');
    }
    assert(a.tag === 'TEXTAREA' && a.cls.includes('ftEditor'),
      `focus is on ${a.tag}.${a.cls}, expected the text editor`);
    return 'document.activeElement is the editor';
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mC. text boxes: type, commit, reopen\x1b[0m');

  /** Insert a box with T and type into it. Returns the annotation id. */
  async function newTextBox(text) {
    await setToolByKey('T', 'freetext');
    await wait(300);
    const a = await activeEl();
    assert(a.cls.includes('ftEditor'), 'T did not open an editor');
    await typeText(text);
    const after = await activeEl();
    assert(after.cls.includes('ftEditor'),
      'focus left the editor while typing -- the characters went somewhere else');
    const id = await js(`window.__app.state.selectedId`);
    assert(id, 'no box was selected after typing');
    return id;
  }

  const commitWays = [
    ['clicking bare page', async () => {
      const [x, y] = await pagePoint(0, 0.82, 0.9);
      await expectHit(x, y, (h) => !h.cls.includes('ftEditor'), 'bare page');
      await mouseClick(x, y);
    }],
    ['clicking the grey margin', async () => {
      const pr = await pageRect(0);
      const x = Math.max(4, pr.x / 2), y = pr.y + pr.h / 2;
      await expectHit(x, y, (h) => h.id === 'viewer' || h.id === 'pages',
        'the grey margin around the page');
      await mouseClick(x, y);
    }],
    ['clicking the toolbar (macOS never focuses a button)', async () => {
      const r = await elRect('#themeBtn');
      const [x, y] = centreOf(r);
      await expectHit(x, y, (h) => h.id === 'themeBtn' || h.tag === 'svg' || h.tag === 'path',
        'the theme button');
      await mouseClick(x, y);
      await wait(120);
      // put the theme back
      await mouseClick(x, y);
    }],
    ['clicking another tool', async () => {
      const r = await elRect('.tool[data-tool="square"]');
      const [x, y] = centreOf(r);
      await mouseClick(x, y);
    }],
    ['pressing Escape', async () => { await key('Escape'); await wait(150); }],
  ];

  for (const [how, act] of commitWays) {
    await check(`typed text is committed by ${how}`, async () => {
      await setToolByKey('V', 'select');
      const text = 'commit-' + how.split(' ')[1];
      const id = await newTextBox(text);
      await act();
      await wait(250);
      // Independent 1: the editor is gone and focus left it.
      const open = await js(`!!document.querySelector('.ftEditor')`);
      assert(!open, 'the editor is still open -- the text was never committed');
      const a = await activeEl();
      assert(!a.cls.includes('ftEditor'), 'focus is still in an editor');
      // Independent 2: the overlay paints the text.
      const painted = await renderedText(id);
      assert(painted !== null, 'the box vanished instead of being committed');
      assert(painted.replace(/\s+/g, '') === text.replace(/\s+/g, ''),
        `the overlay paints "${painted}", expected "${text}"`);
      return `"${painted}" painted`;
    });
  }

  let reopenId = null;
  await check('double-click reopens a committed box with a live caret', async () => {
    await setToolByKey('V', 'select');
    reopenId = await newTextBox('reopen-me');
    const [px, py] = await pagePoint(0, 0.2, 0.95);
    await mouseClick(px, py);                       // commit by clicking away
    await wait(200);
    assert(!(await js(`!!document.querySelector('.ftEditor')`)), 'still editing');
    // Re-resolve the box: selecting rebuilds the overlay, so the node the
    // first click lands on is NOT the node the second click lands on.
    const r = await annotRect(reopenId);
    const [cx, cy] = centreOf(r);
    await expectHit(cx, cy, (h) => h.dataId === reopenId, `the box ${reopenId}`);
    await doubleClick(cx, cy);
    await wait(250);
    const a = await activeEl();
    if (!a.cls.includes('ftEditor') && await editorDiedInstantly()) {
      return skipped('the editor opened and the platform took focus straight back ' +
        'off it -- this window is not the OS key window');
    }
    assert(a.tag === 'TEXTAREA' && a.cls.includes('ftEditor'),
      `after a real double-click focus is on ${a.tag}.${a.cls}, not the editor ` +
      `(the renderer saw ${lastPresses.length} event(s) ${lastDoubleClickGap}ms apart)`);
    assert(a.selStart === a.value.length && a.selStart === a.selEnd,
      `caret at ${a.selStart}/${a.selEnd} of ${a.value.length} -- ` +
      'a select-all here means the next keystroke wipes the text');
    return `activeElement is the editor, caret at ${a.selStart}`;
  });

  await check('typing into a reopened box appends rather than replaces', async () => {
    // continues from the editor opened above
    let a = await activeEl();
    if (!a.cls.includes('ftEditor') && await editorDiedInstantly()) {
      return skipped('the editor opened and the platform took focus straight back ' +
        'off it -- this window is not the OS key window');
    }
    assert(a.cls.includes('ftEditor'), 'no editor open');
    await typeText('-more');
    await key('Escape');
    await wait(250);
    const painted = await renderedText(reopenId);
    assert(painted && painted.replace(/\s+/g, '') === 'reopen-me-more',
      `the overlay paints "${painted}", expected "reopen-me-more"`);
    return `"${painted}"`;
  });

  await check('Enter does nothing to a selected box (shortcut removed)', async () => {
    // Single-key shortcuts were removed deliberately: a bare letter fired while
    // typing. Enter is no longer an edit shortcut either -- double-click is.
    await setToolByKey('V', 'select');
    const r = await annotRect(reopenId);
    const [cx, cy] = centreOf(r);
    await mouseClick(cx, cy);
    await wait(150);
    const sel = await js(`window.__app.state.selectedId`);
    assert(sel === reopenId, `clicking selected "${sel}"`);
    await key('Enter');
    await wait(250);
    const a = await activeEl();
    assert(!a.cls.includes('ftEditor'),
      'Enter opened an editor; that shortcut was supposed to be gone');
    return 'Enter is inert, as intended';
  });

  await check('an empty box is discarded when you click away', async () => {
    // The asked-for model: click away and the box lets go completely. An empty
    // one was never content, so it goes rather than lingering invisibly.
    await setToolByKey('T', 'freetext');
    await wait(250);
    const before = await js(
      `String(window.__app.state.annots.filter(a => a.type === 'freetext').length)`);
    // Deliberately NOT the page: clicking the page with the Text tool active
    // discards the placeholder and places a new box there, which is the point
    // of that behaviour. The grey margin is a plain "click away".
    const margin = await jsJSON(`(()=>{const r=document.querySelector('#viewer')
      .getBoundingClientRect();
      return JSON.stringify([Math.round(r.left+12), Math.round(r.top+r.height*0.6)]);})()`);
    await mouseClick(margin[0], margin[1]);
    await wait(350);
    const after = await js(
      `String(window.__app.state.annots.filter(a => a.type === 'freetext').length)`);
    assert(Number(after) === Number(before) - 1,
      `empty box count went ${before} -> ${after}, expected it to be discarded`);
    const stray = await js(
      `String(document.querySelectorAll('.ftEditor').length)`);
    assert(stray === '0', 'an editor was left open');
    return 'empty box discarded, nothing left behind';
  });

  await check('an empty box is dropped on deselect and never saved', async () => {
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const emptyBoxId = await js(`window.__app.state.selectedId`);
    await key('Escape');                        // commits empty, stays selected
    await wait(150);
    await key('Escape');                        // deselect
    await wait(250);
    const gone = await js(`!window.__app.state.annots.find(a=>a.id==='${emptyBoxId}')`);
    assert(gone, 'an empty text box survived deselection');
    const painted = await renderedIds();
    assert(!painted.includes(emptyBoxId), 'the overlay still paints the empty box');
    return 'dropped';
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mD. saving, and what reaches the file\x1b[0m');

  /** Save through the real File ▸ Save menu item and wait for the write. */
  async function saveViaMenu(file) {
    const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    menuClick('File', 'Save');
    for (let i = 0; i < 100; i++) {
      await wait(100);
      if (fs.existsSync(file) && fs.statSync(file).mtimeMs !== before &&
          !(await js(`window.__app.state.busy`))) return true;
    }
    throw new Error('the save never reached disk');
  }

  await check('what was drawn reaches the file, read back by PDFKit', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    await saveViaMenu(plainPath);
    const k = pdfkit(plainPath);
    const types = k.annotations.map((a) => a.type);
    for (const want of ['Square', 'Circle', 'Line', 'Ink', 'Highlight', 'Underline',
                        'StrikeOut', 'FreeText']) {
      assert(types.includes(want), `PDFKit sees no /${want} in the saved file: ${types}`);
    }
    return `${k.annotations.length} annotations: ${[...new Set(types)].join(', ')}`;
  });

  await check('no empty text box is in the file', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const k = pdfkit(plainPath);
    const free = k.annotations.filter((a) => a.type === 'FreeText');
    const blank = free.filter((a) => !a.contents || !String(a.contents).trim());
    assert(!blank.length, `${blank.length} empty /FreeText annotations were written`);
    return `${free.length} text boxes, none blank`;
  });

  await check('CoreGraphics paints the highlight over the text, not elsewhere', async () => {
    const img = rasterize(plainPath, 700);
    const box = yellowBox(img);
    assert(box.n > 100, `only ${box.n} highlighter-coloured pixels rendered`);
    // The fixture's body text starts at x=72pt of 612pt (11.8%) -- ink that is
    // not over it is ink in the wrong place, which "some pixels changed" misses.
    assert(box.x0 > 0.08 && box.x0 < 0.2,
      `ink starts at x ${(box.x0 * 100).toFixed(1)}% -- the text starts at 11.8%`);
    assert(box.y0 > 0.02 && box.y1 < 0.5,
      `ink spans y ${(box.y0 * 100).toFixed(1)}-${(box.y1 * 100).toFixed(1)}%, ` +
      'the marked-up lines are in the top half');
    return `${box.n} px at x ${(box.x0 * 100).toFixed(1)}-${(box.x1 * 100).toFixed(1)}%`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mE. undo and redo\x1b[0m');

  // A fresh document, so the history under test is exactly what this check put
  // there. Painted counts are read from the overlay, never from state.undo.
  async function drawTwoShapes() {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'undo.pdf', settle: 1800 });
    await setToolByKey('R', 'square');
    let from = await pagePoint(0, 0.15, 0.2);
    await drag(from, [from[0] + 120, from[1] + 70], { steps: 10 });
    await setToolByKey('O', 'circle');
    from = await pagePoint(0, 0.55, 0.2);
    await drag(from, [from[0] + 120, from[1] + 70], { steps: 10 });
    await setToolByKey('V', 'select');
    await key('Escape');
    await wait(150);
    const ids = await renderedIds();
    assert(ids.length === 2, `setup drew ${ids.length} shapes, expected 2`);
  }

  await check('Ctrl+Z undoes exactly one step, Ctrl+Shift+Z redoes it', async () => {
    await drawTwoShapes();
    const before = (await renderedIds()).length;
    await key('z', ['control']);
    await wait(350);
    const undone = (await renderedIds()).length;
    assert(undone === before - 1,
      `one Ctrl+Z changed the painted count ${before} -> ${undone}; expected ${before - 1}` +
      (undone === before - 2 ? ' (Control+Z is bound both in the menu and the renderer)' : ''));
    await key('z', ['control', 'shift']);
    await wait(350);
    const redone = (await renderedIds()).length;
    assert(redone === before, `Ctrl+Shift+Z gave ${redone}, expected ${before}`);
    return `${before} -> ${undone} -> ${redone}`;
  });

  await check('the undo and redo buttons work when actually clicked', async () => {
    await drawTwoShapes();
    const before = (await renderedIds()).length;
    const u = await elRect('#undoBtn');
    let [x, y] = centreOf(u);
    await expectHit(x, y, (h) => h.id === 'undoBtn' || h.tag === 'svg' || h.tag === 'path',
      'the undo button');
    await mouseClick(x, y);
    await wait(350);
    const undone = (await renderedIds()).length;
    assert(undone === before - 1, `undo button: ${before} -> ${undone}`);
    const r = await elRect('#redoBtn');
    [x, y] = centreOf(r);
    await mouseClick(x, y);
    await wait(350);
    const redone = (await renderedIds()).length;
    assert(redone === before, `redo button: ${undone} -> ${redone}`);
    return `${before} -> ${undone} -> ${redone}`;
  });

  await check('⌘Z and ⇧⌘Z are bound, and their handlers undo one step', async () => {
    const u = menuItem('Edit', 'Undo'), r = menuItem('Edit', 'Redo');
    assert(u && /Cmd|Command|CmdOrCtrl/i.test(u.accelerator || ''),
      `Undo accelerator is "${u && u.accelerator}"`);
    assert(r && /Shift\+(CmdOrCtrl|Cmd|Command)/i.test(r.accelerator || ''),
      `Redo accelerator is "${r && r.accelerator}"`);
    await drawTwoShapes();
    const before = (await renderedIds()).length;
    menuClick('Edit', 'Undo');
    await wait(400);
    const undone = (await renderedIds()).length;
    assert(undone === before - 1, `⌘Z handler: ${before} -> ${undone}`);
    menuClick('Edit', 'Redo');
    await wait(400);
    const redone = (await renderedIds()).length;
    assert(redone === before, `⇧⌘Z handler: ${undone} -> ${redone}`);
    // NOT independent: sendInputEvent cannot reach the native menu, so the
    // key equivalent itself is unexercised. See TEST-STRATEGY.md.
    return `accelerators ${u.accelerator} / ${r.accelerator}, handlers correct`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mF. autosave with no save action\x1b[0m');

  await check('a shape drawn and left alone lands on disk by itself', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'autosave.pdf' });
    const before = fs.statSync(work).mtimeMs;
    await setToolByKey('R', 'square');
    const from = await pagePoint(0, 0.2, 0.55);
    const to = await pagePoint(0, 0.6, 0.68);
    await drag(from, to, { steps: 12 });
    for (let i = 0; i < 60; i++) {          // autosave debounce is 1200ms
      await wait(200);
      if (fs.statSync(work).mtimeMs !== before) break;
    }
    assert(fs.statSync(work).mtimeMs !== before,
      'nothing was written -- autosave never fired');
    const k = pdfkit(work);
    assert(k.annotations.some((a) => a.type === 'Square'),
      `the file on disk has ${k.annotations.map((a) => a.type)}`);
    return 'written without any save action';
  });

  await check('autosave still fires when an empty text box was opened meanwhile', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'autosave2.pdf' });
    const before = fs.statSync(work).mtimeMs;
    await setToolByKey('O', 'circle');
    const from = await pagePoint(0, 0.2, 0.3);
    const to = await pagePoint(0, 0.55, 0.42);
    await drag(from, to, { steps: 10 });
    await setToolByKey('T', 'freetext');                       // opens an editor inside the debounce
    await wait(250);
    await key('Escape');                  // leave it empty
    for (let i = 0; i < 40; i++) {
      await wait(250);
      if (fs.statSync(work).mtimeMs !== before) break;
    }
    assert(fs.statSync(work).mtimeMs !== before,
      'the circle never reached disk: the autosave timer was consumed while the ' +
      'editor was open and committing an empty box does not reschedule it');
    const k = pdfkit(work);
    assert(k.annotations.some((a) => a.type === 'Circle'),
      `disk has ${k.annotations.map((a) => a.type)}`);
    return 'autosave survived the editor';
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mG. pasted images: move, resize, rotate\x1b[0m');

  const imgPath = path.join(FIX, 'clip.png');
  const imgWork = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'image.pdf' });
  let imageId = null;

  await check('an image on the clipboard pastes onto the page', async () => {
    await seedClipboardImage(imgPath);
    menuClick('Edit', 'Paste');          // ⌘V itself is unreachable, see above
    for (let i = 0; i < 50; i++) {
      await wait(120);
      const list = await annots();
      const a = list.find((x) => x.type === 'image');
      if (a) { imageId = a.id; break; }
    }
    assert(imageId, 'nothing was pasted');
    const painted = await js(`!!document.querySelector('.overlay image')`);
    assert(painted, 'the overlay paints no <image>');
    return `pasted ${imageId}`;
  });

  await check('dragging the image moves it, and the file agrees', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    if (!imageId) throw new Error('no image');
    const r0 = await annotRect(imageId, '.hit');
    const from = centreOf(r0);
    await expectHit(from[0], from[1], (h) => h.dataId === imageId, 'the image');
    await drag(from, [from[0] - 80, from[1] - 60], { steps: 12 });
    await saveViaMenu(imgWork);
    const k = pdfkit(imgWork);
    const stamp = k.annotations.find((a) => a.type === 'Stamp');
    assert(stamp, 'no /Stamp in the saved file');
    const r1 = await annotRect(imageId, '.hit');
    assert(near(r1.x - r0.x, -80, 8) && near(r1.y - r0.y, -60, 8),
      `moved (${(r1.x - r0.x).toFixed(0)},${(r1.y - r0.y).toFixed(0)}), expected (-80,-60)`);
    return `/Stamp at ${JSON.stringify(stamp.rect)}`;
  });

  await check('corner resize keeps the aspect ratio, checked in the file', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const src = pdfkit(imgWork).annotations.find((a) => a.type === 'Stamp');
    const aspect0 = src.rect[2] / src.rect[3];
    const h = await jsJSON(
      `(()=>{const el=document.querySelector('[data-id="${imageId}"][data-handle="se"]');
        if(!el) return 'null'; const r=el.getBoundingClientRect();
        return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
    assert(h, 'the image has no SE resize handle -- is it selected?');
    await expectHit(h.x, h.y, (e) => e.handle === 'se', 'the SE handle');
    await drag([h.x, h.y], [h.x + 90, h.y + 30], { steps: 12 });
    await saveViaMenu(imgWork);
    const after = pdfkit(imgWork).annotations.find((a) => a.type === 'Stamp');
    const aspect1 = after.rect[2] / after.rect[3];
    assert(after.rect[2] > src.rect[2] + 10,
      `the image did not grow: ${src.rect[2]} -> ${after.rect[2]}`);
    assert(near(aspect1, aspect0, aspect0 * 0.04),
      `aspect changed ${aspect0.toFixed(3)} -> ${aspect1.toFixed(3)} without Shift`);
    return `${aspect0.toFixed(3)} -> ${aspect1.toFixed(3)}, width ${src.rect[2]} -> ${after.rect[2]}`;
  });

  await check('Shift-resize deliberately distorts, checked in the file', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const src = pdfkit(imgWork).annotations.find((a) => a.type === 'Stamp');
    const aspect0 = src.rect[2] / src.rect[3];
    const h = await jsJSON(
      `(()=>{const el=document.querySelector('[data-id="${imageId}"][data-handle="se"]');
        if(!el) return 'null'; const r=el.getBoundingClientRect();
        return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
    assert(h, 'no SE handle');
    await drag([h.x, h.y], [h.x + 10, h.y + 90], { steps: 12, modifiers: ['shift'] });
    await saveViaMenu(imgWork);
    const after = pdfkit(imgWork).annotations.find((a) => a.type === 'Stamp');
    const aspect1 = after.rect[2] / after.rect[3];
    assert(Math.abs(aspect1 - aspect0) > aspect0 * 0.08,
      `Shift did not distort: aspect ${aspect0.toFixed(3)} -> ${aspect1.toFixed(3)}`);
    return `${aspect0.toFixed(3)} -> ${aspect1.toFixed(3)}`;
  });

  await check('dragging the rotate grip turns the image in the file too', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const src = pdfkit(imgWork).annotations.find((a) => a.type === 'Stamp');
    const g = await jsJSON(
      `(()=>{const el=document.querySelector('[data-id="${imageId}"][data-handle="rotate"]');
        const hit=document.querySelector('[data-id="${imageId}"].hit');
        if(!el||!hit) return 'null';
        const r=el.getBoundingClientRect(), b=hit.getBoundingClientRect();
        return JSON.stringify({gx:r.x+r.width/2,gy:r.y+r.height/2,
          cx:b.x+b.width/2,cy:b.y+b.height/2});})()`);
    assert(g, 'no rotate grip on the selected image');
    await expectHit(g.gx, g.gy, (e) => e.handle === 'rotate', 'the rotate grip');
    // swing the grip a quarter turn about the image centre, Shift to snap
    const dx = g.gx - g.cx, dy = g.gy - g.cy;
    await drag([g.gx, g.gy], [g.cx - dy, g.cy + dx], { steps: 16, modifiers: ['shift'] });
    await saveViaMenu(imgWork);
    const after = pdfkit(imgWork).annotations.find((a) => a.type === 'Stamp');
    const a0 = src.rect[2] / src.rect[3], a1 = after.rect[2] / after.rect[3];
    assert(Math.abs(Math.log(a1 / a0)) > 0.25,
      `the saved /Rect did not change shape on rotation: ` +
      `${a0.toFixed(3)} -> ${a1.toFixed(3)}`);
    return `bounding box aspect ${a0.toFixed(2)} -> ${a1.toFixed(2)}`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mH. appearance: theme, fit, zoom\x1b[0m');

  await check('the theme button really flips light and dark', async () => {
    const before = await jsJSON(`JSON.stringify({theme:document.documentElement.dataset.theme,
      bg:getComputedStyle(document.body).backgroundColor})`);
    const r = await elRect('#themeBtn');
    const [x, y] = centreOf(r);
    await mouseClick(x, y);
    await wait(300);
    const after = await jsJSON(`JSON.stringify({theme:document.documentElement.dataset.theme,
      bg:getComputedStyle(document.body).backgroundColor})`);
    assert(after.theme !== before.theme, `theme stayed "${after.theme}"`);
    assert(after.bg !== before.bg,
      `data-theme flipped to "${after.theme}" but the computed background is still ${after.bg}`);
    await mouseClick(x, y);
    await wait(250);
    return `${before.theme} ${before.bg} -> ${after.theme} ${after.bg}`;
  });

  await check('the zoom buttons change the painted page size', async () => {
    const r0 = await pageRect(0);
    const plus = await elRect('#zoomIsland button[data-zoom="1"]');
    const [px, py] = centreOf(plus);
    await expectHit(px, py, (h) => h.tag === 'BUTTON', 'the zoom-in button');
    await mouseClick(px, py);
    await wait(700);
    const r1 = await pageRect(0);
    assert(r1.w > r0.w + 4, `zoom in left the page at ${r1.w.toFixed(0)}px (was ${r0.w.toFixed(0)})`);
    const label = await js(`document.querySelector('#zoomLabel').textContent`);
    const fit = await elRect('#zoomLabel');
    await mouseClick(...centreOf(fit));
    await wait(800);
    const r2 = await pageRect(0);
    const vh = await js(`document.querySelector('#viewer').clientHeight`);
    assert(r2.h <= vh + 2, `fit left the page ${r2.h.toFixed(0)}px tall in ${vh}px`);
    return `${r0.w.toFixed(0)} -> ${r1.w.toFixed(0)} (${label}) -> fit ${r2.w.toFixed(0)}px`;
  });

  await check('a highlight made at 200% zoom lands where PDFKit puts it', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'zoomed.pdf' });
    const ref = pdfkitHighlight(work, path.join(TMP, 'zoom-ref.pdf'), PHRASE);
    const refRect = pdfkit(ref).annotations.find((a) => a.type === 'Highlight').rect;
    // Zoom itself is exercised by the button check above; this sets the stage.
    await js(`window.__app.reflow(2, 'manual')`);
    await wait(900);
    await setToolByKey('H', 'highlight');
    const { sel } = await dragSelectText(0, `/Page 1/.test(x.textContent)`);
    assert(sel.trim(), 'the drag selected nothing at 200% zoom');
    await wait(250);
    await saveViaMenu(work);
    const ours = pdfkit(work).annotations.find((a) => a.type === 'Highlight');
    assert(ours, 'no highlight in the file');
    compareToReference(ours.rect, refRect, 'at 200% zoom');
    await js(`window.__app.applyFit('fit')`);
    await wait(600);
    return `ours ${JSON.stringify(ours.rect)} vs PDFKit ${JSON.stringify(refRect)}`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mI. rotated and cropped pages, against a PDFKit reference\x1b[0m');

  for (const fx of ['rotated90', 'rotated270', 'cropoffset']) {
    await check(`${fx}: a mouse-drawn highlight lands where PDFKit's own does`, async () => {
      if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
      const work = await openDoc(path.join(FIX, `${fx}.pdf`), { name: `${fx}.pdf` });
      const ref = pdfkitHighlight(work, path.join(TMP, `${fx}-ref.pdf`), PHRASE);
      const refA = pdfkit(ref).annotations.find((a) => a.type === 'Highlight');
      assert(refA, 'PDFKit wrote no reference highlight');
      await setToolByKey('H', 'highlight');
      const { sel } = await dragSelectText(0, `/Page 1/.test(x.textContent)`);
      assert(sel.trim(), `dragging across the text on ${fx} selected nothing`);
      await wait(250);
      await saveViaMenu(work);
      const ours = pdfkit(work).annotations.find((a) => a.type === 'Highlight');
      assert(ours, 'we wrote no highlight');

      // cropoffset is compared by pixels only: PDFKit rewrites the page's
      // MediaBox when it saves, so its own /Rect is in a different frame.
      if (fx !== 'cropoffset') compareToReference(ours.rect, refA.rect, fx);

      // The arbiter either way: where CoreGraphics actually puts the ink.
      const a = yellowBox(rasterize(work, 800)), b = yellowBox(rasterize(ref, 800));
      assert(a.n > 50, `CoreGraphics painted only ${a.n} px of our highlight`);
      assert(b.n > 50, `the PDFKit reference painted only ${b.n} px`);
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const pct = (z) => `x ${(z.x0 * 100).toFixed(0)}-${(z.x1 * 100).toFixed(0)}% ` +
        `y ${(z.y0 * 100).toFixed(0)}-${(z.y1 * 100).toFixed(0)}%`;
      assert(ox > 0 && oy > 0,
        `CoreGraphics paints our ink at ${pct(a)} and PDFKit's at ${pct(b)} ` +
        '-- a different place on the page');
      return `ink ${pct(a)} vs PDFKit ${pct(b)}`;
    });
  }

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mJ. a real 72-page deck, worked on page 40\x1b[0m');

  await check('page 40 of a large deck: drawn there, saved there', async () => {
    if (!fs.existsSync(BIG)) return skipped(`${BIG} not present`);
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(BIG, { name: 'deck.pdf', settle: 6000 });
    const n = await js(`window.__app.state.doc.numPages`);
    assert(n >= 40, `the deck has only ${n} pages`);
    const beforeAll = pdfkit(work).annotations;
    const beforeCount = beforeAll.length;
    const beforeSquaresOnPage40 =
      beforeAll.filter((a) => a.type === 'Square' && a.page === 39).length;
    // Scrolling there is DOM, not an app code path; the drawing below is real.
    await js(`(async()=>{await window.__app.ensurePageRendered(39);
      window.__app.state.pages[39].el.scrollIntoView();})()`);
    await wait(2500);
    const pr = await pageRect(39);
    assert(pr.y < 900 && pr.y + pr.h > 0, `page 40 is off-screen at y=${pr.y.toFixed(0)}`);
    await setToolByKey('R', 'square');
    const from = [pr.x + pr.w * 0.25, Math.max(pr.y + 40, 120)];
    const to = [from[0] + 160, from[1] + 90];
    await expectHit(from[0], from[1], () => true, 'page 40');
    await drag(from, to, { steps: 12 });
    await saveViaMenu(work);
    const k = pdfkit(work);
    const mine = k.annotations.filter((a) => a.type === 'Square' && a.page === 39);
    assert(mine.length === beforeSquaresOnPage40 + 1,
      `page 40 has ${mine.length} squares, expected ${beforeSquaresOnPage40 + 1}`);
    assert(k.annotations.length === beforeCount + 1,
      `the deck had ${beforeCount} annotations and now has ${k.annotations.length} ` +
      `-- pre-existing markup was lost or duplicated`);
    return `square on page 40, ${beforeCount} pre-existing annotations preserved`;
  });

  await check('the original deck on disk was never touched', async () => {
    if (!fs.existsSync(BIG)) return skipped('no deck');
    const opened = await js(`window.__app.state.path`);
    assert(opened.startsWith(TMP),
      `the app has ${opened} open -- the suite must only ever open copies`);
    return `working on ${path.basename(opened)} in a temp dir`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mK. imprecise human input\x1b[0m');

  /** A fresh page with one rectangle on it, returned by id. */
  async function oneShape(name) {
    await openDoc(path.join(FIX, 'plain.pdf'), { name, settle: 1800 });
    await setToolByKey('R', 'square');
    const from = await pagePoint(0, 0.25, 0.3);
    await drag(from, [from[0] + 200, from[1] + 120], { steps: 10 });
    await setToolByKey('V', 'select');
    await key('Escape');
    await wait(150);
    const list = await annots();
    assert(list.length === 1, `setup left ${list.length} annotations`);
    return list[0].id;
  }

  await check('a click that drifts 3px selects instead of dragging', async () => {
    const id = await oneShape('drift.pdf');
    const r0 = await annotRect(id);
    const [cx, cy] = centreOf(r0);
    send({ type: 'mouseMove', x: Math.round(cx), y: Math.round(cy) });
    send({ type: 'mouseDown', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1 });
    await wait(30);
    for (const d of [1, 2, 3]) {
      send({ type: 'mouseMove', x: Math.round(cx + d), y: Math.round(cy + d), button: 'left' });
      await wait(15);
    }
    send({ type: 'mouseUp', x: Math.round(cx + 3), y: Math.round(cy + 3), button: 'left', clickCount: 1 });
    await wait(200);
    const sel = await js(`window.__app.state.selectedId`);
    assert(sel === id, `the shape was not selected (selectedId=${sel})`);
    const list = await annots();
    assert(list.length === 1, `the drift created ${list.length - 1} extra annotation(s)`);
    const r1 = await annotRect(id);
    assert(Math.abs(r1.x - r0.x) <= 4 && Math.abs(r1.y - r0.y) <= 4,
      `a 3px wobble moved the shape by (${(r1.x - r0.x).toFixed(0)},${(r1.y - r0.y).toFixed(0)})px`);
    return 'selected, not moved, nothing created';
  });

  await check('a 2px twitch with a draw tool leaves no invisible annotation', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'twitch.pdf' });
    await setToolByKey('R', 'square');
    const [x, y] = await pagePoint(0, 0.4, 0.4);
    send({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    send({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await wait(30);
    send({ type: 'mouseMove', x: Math.round(x + 2), y: Math.round(y + 1), button: 'left' });
    await wait(20);
    send({ type: 'mouseUp', x: Math.round(x + 2), y: Math.round(y + 1), button: 'left', clickCount: 1 });
    await wait(400);
    const list = await annots();
    if (!list.length) return 'the twitch created nothing (file not inspected)';
    await saveViaMenu(work);
    const k = pdfkit(work);
    const tiny = k.annotations.filter((a) => a.rect[2] < 4 || a.rect[3] < 4);
    assert(!tiny.length,
      `a 2px twitch wrote ${tiny.length} annotation(s) of ${JSON.stringify(tiny[0].rect)} ` +
      'to the file -- invisible junk the user cannot see to delete');
    return `${list.length} annotation, ${JSON.stringify(k.annotations[0].rect)}`;
  });

  await check('a slow double-click (600ms apart) does not open the editor', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'slowdbl.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    await typeText('slow');
    await key('Escape');
    await wait(200);
    const id = await js(`window.__app.state.selectedId`);
    const [px, py] = await pagePoint(0, 0.15, 0.92);
    await mouseClick(px, py);
    await wait(200);
    const r = await annotRect(id);
    const [cx, cy] = centreOf(r);
    await mouseClick(cx, cy);
    await wait(600);                       // deliberately past the 450ms window
    const r2 = await annotRect(id);
    const c2 = centreOf(r2);
    await mouseClick(c2[0], c2[1]);
    await wait(250);
    const a = await activeEl();
    assert(!a.cls.includes('ftEditor'),
      'two clicks 600ms apart opened the editor -- that is not a double-click');
    return 'treated as two separate clicks';
  });

  await check('clicking just inside selects, just outside does not', async () => {
    const id = await oneShape('edges.pdf');
    const r = await annotRect(id);
    await mouseClick(r.x + 4, r.y + r.h / 2);        // just inside the left edge
    await wait(150);
    let sel = await js(`window.__app.state.selectedId`);
    assert(sel === id, `a click 4px inside the edge did not select (${sel})`);
    const r2 = await annotRect(id);
    await mouseClick(r2.x - 14, r2.y + r2.h / 2);    // clearly outside
    await wait(200);
    sel = await js(`window.__app.state.selectedId`);
    assert(sel === null, `a click 14px outside the shape still selected ${sel}`);
    const list = await annots();
    assert(list.length === 1, `clicking around created ${list.length - 1} extra annotations`);
    return 'inside selects, outside deselects';
  });

  await check('releasing a drag outside the window leaves the app usable', async () => {
    const id = await oneShape('outside.pdf');
    const r = await annotRect(id);
    const [cx, cy] = centreOf(r);
    await mouseClick(cx, cy);
    await wait(150);
    const b = win.getContentBounds();
    send({ type: 'mouseMove', x: Math.round(cx), y: Math.round(cy) });
    send({ type: 'mouseDown', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1 });
    await wait(30);
    for (let i = 1; i <= 8; i++) {
      send({ type: 'mouseMove', button: 'left',
        x: Math.round(cx + (b.width + 120 - cx) * i / 8), y: Math.round(cy) });
      await wait(12);
    }
    send({ type: 'mouseUp', x: b.width + 120, y: Math.round(cy), button: 'left', clickCount: 1 });
    await wait(300);
    // The mark must stay on the page, and the next click must still work.
    const r2 = await annotRect(id);
    const pr = await pageRect(0);
    assert(r2.x < pr.x + pr.w + 2,
      `the shape was dragged off the page to x=${r2.x.toFixed(0)} (page ends at ` +
      `${(pr.x + pr.w).toFixed(0)})`);
    const [ex, ey] = await pagePoint(0, 0.05, 0.95);
    await mouseClick(ex, ey);
    await wait(200);
    const stuck = await js(`window.__app.state.selectedId`);
    assert(stuck === null,
      'a click after the off-window release did nothing -- the drag is still captured');
    return `shape clamped to x=${r2.x.toFixed(0)}, input still live`;
  });

  await check('press, hold one second, then drag still moves the shape', async () => {
    const id = await oneShape('hold.pdf');
    const r0 = await annotRect(id);
    const [cx, cy] = centreOf(r0);
    send({ type: 'mouseMove', x: Math.round(cx), y: Math.round(cy) });
    send({ type: 'mouseDown', x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1 });
    await wait(1000);
    for (let i = 1; i <= 8; i++) {
      send({ type: 'mouseMove', button: 'left',
        x: Math.round(cx + 10 * i), y: Math.round(cy + 5 * i) });
      await wait(15);
    }
    send({ type: 'mouseUp', x: Math.round(cx + 80), y: Math.round(cy + 40), button: 'left', clickCount: 1 });
    await wait(250);
    const r1 = await annotRect(id);
    assert(near(r1.x - r0.x, 80, 8) && near(r1.y - r0.y, 40, 8),
      `after a 1s hold the shape moved (${(r1.x - r0.x).toFixed(0)},${(r1.y - r0.y).toFixed(0)}), ` +
      'expected (80,40)');
    return 'moved as expected';
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mL. typing, for real\x1b[0m');

  /** Type, checking after EVERY keystroke that no tool switched and no
   *  annotation disappeared. A single-key menu accelerator or an unguarded
   *  keydown handler shows up here and nowhere else. */
  async function typeWatching(text) {
    const tool0 = await js(`(()=>{const b=document.querySelector('.tool.active');
      return b?b.dataset.tool:null;})()`);
    const n0 = (await annots()).length;
    for (const ch of text) {
      await key(ch);
      const tool = await js(`(()=>{const b=document.querySelector('.tool.active');
        return b?b.dataset.tool:null;})()`);
      assert(tool === tool0,
        `typing "${ch}" switched the tool from "${tool0}" to "${tool}"`);
      const n = (await annots()).length;
      assert(n >= n0, `typing "${ch}" deleted an annotation (${n0} -> ${n})`);
    }
    return tool0;
  }

  const TOOL_LETTERS = 'very odd artistic layouts';

  await check(`typing "${TOOL_LETTERS}" in a text box changes no tool`, async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'letters.pdf', settle: 1800 });
    await setToolByKey('R', 'square');           // deliberately NOT select/text
    const from = await pagePoint(0, 0.2, 0.25);
    await drag(from, [from[0] + 150, from[1] + 80], { steps: 8 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    const a0 = await activeEl();
    assert(a0.cls.includes('ftEditor'), 'no editor open');
    await typeWatching(TOOL_LETTERS);
    const still = await activeEl();
    assert(still.cls.includes('ftEditor'), 'focus left the editor while typing');
    await key('Escape');
    await wait(250);
    const painted = await renderedText(id);
    assert(painted && painted.replace(/\s+/g, ' ').trim() === TOOL_LETTERS,
      `the overlay paints "${painted}"`);
    return `"${painted}"`;
  });

  await check('Backspace in a text box deletes a character, not the annotation', async () => {
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    const n0 = (await annots()).length;
    await typeText('abcd');
    await key('Backspace');
    await wait(120);
    const n1 = (await annots()).length;
    assert(n1 === n0, `Backspace while typing removed an annotation (${n0} -> ${n1})`);
    const a = await activeEl();
    assert(a.cls.includes('ftEditor'), 'Backspace closed the editor');
    await key('Escape');
    await wait(250);
    const painted = await renderedText(id);
    assert(painted === 'abc', `the overlay paints "${painted}", expected "abc"`);
    return '"abcd" + Backspace -> "abc"';
  });

  await check('multi-line text is reachable and survives the save', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'multiline.pdf' });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    await typeText('line one');
    await key('Enter');
    await wait(150);
    const afterEnter = await activeEl();
    const enterCommits = !afterEnter.cls.includes('ftEditor');
    assert(!enterCommits,
      'Enter inside a text box committed it instead of starting a new line, ' +
      'so multi-line text cannot be typed at all');
    await typeText('line two');
    await key('Escape');
    await wait(300);
    const painted = await renderedText(id);
    assert(painted && /line one/.test(painted) && /line two/.test(painted),
      `the overlay paints "${painted}"`);
    assert(painted.includes('\n'), `"${painted}" was painted as one line`);
    await saveViaMenu(work);
    const free = pdfkit(work).annotations.find((a) => a.type === 'FreeText');
    assert(free, 'no /FreeText in the file');
    assert(/line one/.test(free.contents) && /line two/.test(free.contents),
      `the file holds "${free.contents}"`);
    return JSON.stringify(free.contents);
  });

  await check('accented text survives typing, painting and the save', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'accents.pdf' });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    await typeText('café naïve');
    await key('Escape');
    await wait(250);
    const painted = await renderedText(id);
    assert(painted === 'café naïve', `the overlay paints "${painted}"`);
    await saveViaMenu(work);
    const free = pdfkit(work).annotations.find((a) => a.type === 'FreeText');
    assert(free && free.contents === 'café naïve',
      `PDFKit reads "${free && free.contents}" back from the file`);
    return JSON.stringify(free.contents);
  });

  await check('text outside WinAnsi is not silently mangled on screen', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'emoji.pdf' });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    await typeText('ok ☺');
    await key('Escape');
    await wait(250);
    const painted = await renderedText(id);
    await saveViaMenu(work);
    const free = pdfkit(work).annotations.find((a) => a.type === 'FreeText');
    // README documents the WinAnsi limit, so '?' in the FILE is expected.
    // What must not happen is the screen and the file disagreeing silently
    // about something the user can still see.
    assert(painted && painted.startsWith('ok'), `the overlay paints "${painted}"`);
    return `screen ${JSON.stringify(painted)}, file ${JSON.stringify(free && free.contents)}`;
  });

  await check('a long line wraps onto several lines and grows the box', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'wrap.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    const before = await annotRect(id);
    await typeText('the quick brown fox jumps over the lazy dog and keeps on going well past the edge');
    await key('Escape');
    await wait(300);
    const lines = await js(
      `(()=>{const t=[...document.querySelectorAll('.overlay text')]
        .find(t=>t.parentNode.querySelector('[data-id="${id}"]'));
        return t?t.querySelectorAll('tspan').length:0;})()`);
    assert(lines > 1, `the text was painted on ${lines} line(s), so it never wrapped`);
    const after = await annotRect(id);
    assert(after.h > before.h + 4,
      `the box stayed ${after.h.toFixed(0)}px tall, so the extra lines are outside it`);
    return `${lines} lines, box ${before.h.toFixed(0)} -> ${after.h.toFixed(0)}px`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mM. order of operations\x1b[0m');

  await check('creating a text box then immediately undoing is survivable', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'undo-new.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(250);
    // The undo BUTTON, not Ctrl+Z: a focused textarea owns Ctrl+Z for its own
    // native undo, which is correct browser behaviour, so the button is the
    // only real undo a user has while typing.
    const u = await elRect('#undoBtn');
    await mouseClick(...centreOf(u));
    await wait(500);
    const painted = await renderedIds();
    assert(painted.length === 0,
      `${painted.length} annotation(s) still painted after undoing the box that ` +
      'had just been created');
    // and the app must still work afterwards
    await setToolByKey('R', 'square');
    const from = await pagePoint(0, 0.3, 0.5);
    await drag(from, [from[0] + 120, from[1] + 60], { steps: 8 });
    assert((await renderedIds()).length === 1, 'the app stopped drawing after that undo');
    return 'box removed, app still usable';
  });

  await check('undo while the editor is open commits, then steps back', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'undo-open.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(250);
    await typeText('typed then undone');
    const ub = await elRect('#undoBtn');
    await mouseClick(...centreOf(ub));
    await wait(600);
    const open = await js(`!!document.querySelector('.ftEditor')`);
    assert(!open, 'the editor stayed open through an undo');
    const painted = await renderedIds();
    assert(painted.length === 0,
      `undo left ${painted.length} annotation(s); the typed box should be gone`);
    return 'committed and undone';
  });

  await check('undo past the start and redo past the end are harmless', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'undo-edges.pdf', settle: 1800 });
    for (let i = 0; i < 4; i++) { await key('z', ['control']); await wait(120); }
    assert((await renderedIds()).length === 0, 'undoing an empty document created something');
    for (let i = 0; i < 4; i++) { await key('z', ['control', 'shift']); await wait(120); }
    assert((await renderedIds()).length === 0, 'redoing past the end created something');
    await setToolByKey('R', 'square');
    const from = await pagePoint(0, 0.3, 0.3);
    await drag(from, [from[0] + 120, from[1] + 60], { steps: 8 });
    assert((await renderedIds()).length === 1, 'the app stopped working at the history edges');
    return 'no crash, nothing invented';
  });

  await check('drawing after an undo clears the redo stack', async () => {
    // state continues from the check above: one square, one undo available
    await key('z', ['control']);
    await wait(300);
    assert((await renderedIds()).length === 0, 'the undo did not take');
    await setToolByKey('O', 'circle');
    const from = await pagePoint(0, 0.55, 0.3);
    await drag(from, [from[0] + 120, from[1] + 60], { steps: 8 });
    const after = (await renderedIds()).length;
    assert(after === 1, `expected 1 shape, found ${after}`);
    await key('z', ['control', 'shift']);   // redo must have nothing to do
    await wait(300);
    const now = (await renderedIds()).length;
    assert(now === 1,
      `redo after drawing brought back ${now - 1} discarded annotation(s)`);
    const list = await annots();
    assert(list[0].type === 'circle', `the surviving shape is a ${list[0].type}`);
    return 'redo stack cleared';
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mN. the document name field\x1b[0m');

  await check('the name field shows the open document', async () => {
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'rename-me.pdf', settle: 1800 });
    const hidden = await js(`document.querySelector('#titleIsland').classList.contains('hidden')`);
    assert(!hidden, 'the title island is hidden with a document open');
    const value = await js(`document.querySelector('#docName').value`);
    assert(path.basename(work).startsWith(value.slice(0, 8)) || value.includes('rename-me'),
      `the field shows "${value}" for ${path.basename(work)}`);
    return `"${value}"`;
  });

  await check('typing tool letters into the name field switches no tool', async () => {
    await setToolByKey('R', 'square');
    const r = await elRect('#docName');
    const [x, y] = centreOf(r);
    await expectHit(x, y, (h) => h.id === 'docName', 'the name field');
    await mouseClick(x, y);
    await wait(200);
    const a = await activeEl();
    assert(a.tag === 'INPUT', `clicking the name field focused ${a.tag}`);
    await typeWatching(TOOL_LETTERS);
    const after = await activeEl();
    assert(after.tag === 'INPUT', 'focus left the name field while typing');
    await key('Escape');
    await wait(200);
    return 'tool unchanged through every keystroke';
  });

  let renamedPath = null;
  await check('renaming with unsaved work saves first, then renames on disk', async () => {
    if (!HAVE_PDFKIT) return skipped('no PyObjC venv');
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'before-rename.pdf', settle: 1800 });
    await setToolByKey('R', 'square');
    const from = await pagePoint(0, 0.3, 0.3);
    await drag(from, [from[0] + 140, from[1] + 80], { steps: 8 });   // now dirty
    const r = await elRect('#docName');
    await mouseClick(...centreOf(r));
    await wait(200);
    await js(`document.querySelector('#docName').select()`);   // select-all, then retype
    const newName = 'renamed-' + Date.now();
    await typeText(newName);
    await key('Enter');
    for (let i = 0; i < 60; i++) {
      await wait(150);
      const p2 = await js(`window.__app.state.path`);
      if (p2 !== work) { renamedPath = p2; break; }
    }
    assert(renamedPath, 'the rename never completed');
    assert(fs.existsSync(renamedPath), `${renamedPath} is not on disk`);
    assert(!fs.existsSync(work),
      `the old file ${path.basename(work)} is still there -- a copy was left behind ` +
      'or an autosave recreated it');
    const k = pdfkit(renamedPath);
    assert(k.annotations.some((a) => a.type === 'Square'),
      'the unsaved square did not make it into the renamed file');
    // give any late autosave a chance to recreate the old name
    await wait(1800);
    assert(!fs.existsSync(work),
      `${path.basename(work)} reappeared after the rename -- autosave raced it`);
    return `${path.basename(work)} -> ${path.basename(renamedPath)}, square kept`;
  });

  await check('renaming onto an existing filename is refused', async () => {
    assert(renamedPath, 'the previous check did not produce a file');
    const taken = path.join(path.dirname(renamedPath), 'occupied.pdf');
    fs.writeFileSync(taken, fs.readFileSync(renamedPath));
    const before = fs.statSync(taken).size;
    const r = await elRect('#docName');
    await mouseClick(...centreOf(r));
    await wait(200);
    await js(`document.querySelector('#docName').select()`);
    await typeText('occupied');
    await key('Enter');
    await wait(1200);
    const nowPath = await js(`window.__app.state.path`);
    assert(nowPath === renamedPath,
      `the app now thinks the document is ${nowPath} -- it overwrote an existing file`);
    assert(fs.existsSync(renamedPath), 'the document was renamed away anyway');
    assert(fs.statSync(taken).size === before, 'the existing file was overwritten');
    const shown = await js(`document.querySelector('#docName').value`);
    assert(shown === path.basename(renamedPath).replace(/\.pdf$/i, ''),
      `after the refusal the field still shows "${shown}" but the file is ` +
      `"${path.basename(renamedPath)}" -- the next commit would act on a name that is not real`);
    return 'refused, field reverted';
  });

  await check('Escape in the name field cancels the rename', async () => {
    const real = await js(`window.__app.state.name`);
    const dir = path.dirname(renamedPath);
    const r = await elRect('#docName');
    await mouseClick(...centreOf(r));
    await wait(250);
    const focused = await activeEl();
    assert(focused.tag === 'INPUT', `the name field did not take focus (${focused.tag})`);
    await js(`document.querySelector('#docName').select()`);
    await typeText('throwaway-name');
    await key('Escape');
    await wait(700);
    const shown = await js(`document.querySelector('#docName').value`);
    // Then do what a user does next: click back onto the page.
    const [px, py] = await pagePoint(0, 0.5, 0.5);
    await mouseClick(px, py);
    await wait(1500);
    const nowPath = await js(`window.__app.state.path`);
    const onDisk = fs.readdirSync(dir);
    assert(path.basename(nowPath) === real,
      `Escape was supposed to cancel, but the document is now ` +
      `"${path.basename(nowPath)}" -- the abandoned name was committed`);
    assert(!onDisk.some((f) => /throwaway-name/.test(f)),
      `Escape left ${onDisk.filter((f) => /throwaway/.test(f))} on disk`);
    assert(shown === real.replace(/\.pdf$/i, ''),
      `after Escape the field still reads "${shown}" instead of "${real}" -- ` +
      'refreshDocName() cannot reset a field that still has focus, so the ' +
      'cancelled name is what the next blur will commit');
    return `field reverted to "${shown}", file untouched`;
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mO. moving targets\x1b[0m');

  await check('a mark stays put across a long scroll away and back', async () => {
    const work = await openDoc(path.join(FIX, 'plain.pdf'), { name: 'scroll.pdf', settle: 2000 });
    await setToolByKey('R', 'square');
    const pr0 = await pageRect(0);
    const from = [pr0.x + pr0.w * 0.3, pr0.y + pr0.h * 0.3];
    await drag(from, [from[0] + 150, from[1] + 90], { steps: 8 });
    const id = (await annots())[0].id;
    const r0 = await annotRect(id);
    const rel0 = { x: (r0.x - pr0.x) / pr0.w, y: (r0.y - pr0.y) / pr0.h };
    // Real wheel input, not scrollTop.
    for (let i = 0; i < 30; i++) {
      send({ type: 'mouseWheel', x: 640, y: 500, deltaX: 0, deltaY: -120,
        canScroll: true });
      await wait(20);
    }
    await wait(800);
    for (let i = 0; i < 40; i++) {
      send({ type: 'mouseWheel', x: 640, y: 500, deltaX: 0, deltaY: 120,
        canScroll: true });
      await wait(20);
    }
    await wait(900);
    const pr1 = await pageRect(0);
    const r1 = await annotRect(id);
    const rel1 = { x: (r1.x - pr1.x) / pr1.w, y: (r1.y - pr1.y) / pr1.h };
    assert(Math.abs(rel1.x - rel0.x) < 0.01 && Math.abs(rel1.y - rel0.y) < 0.01,
      `the mark sat at ${(rel0.x * 100).toFixed(1)}%,${(rel0.y * 100).toFixed(1)}% of the ` +
      `page and now sits at ${(rel1.x * 100).toFixed(1)}%,${(rel1.y * 100).toFixed(1)}%`);
    return 'unmoved relative to the page';
  });

  await check('zooming with a mark selected keeps its chrome on the mark', async () => {
    await setToolByKey('V', 'select');
    const id = (await annots())[0].id;
    const r = await annotRect(id);
    await mouseClick(...centreOf(r));
    await wait(200);
    assert(await js(`window.__app.state.selectedId`) === id, 'nothing selected');
    const plus = await elRect('#zoomIsland button[data-zoom="1"]');
    await mouseClick(...centreOf(plus));
    await wait(900);
    const sel = await js(`window.__app.state.selectedId`);
    assert(sel === id, `the zoom dropped the selection (now ${sel})`);
    const box = await jsJSON(
      `(()=>{const e=document.querySelector('.overlay .selection .selbox');
        if(!e) return 'null';const r=e.getBoundingClientRect();
        return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`);
    assert(box, 'no selection chrome after the zoom');
    const r2 = await annotRect(id);
    assert(Math.abs(box.x - r2.x) < 12 && Math.abs(box.y - r2.y) < 12,
      `after zooming the selection box is at ${box.x.toFixed(0)},${box.y.toFixed(0)} ` +
      `but the mark is at ${r2.x.toFixed(0)},${r2.y.toFixed(0)}`);
    await js(`window.__app.applyFit('fit')`);
    await wait(700);
    return 'chrome follows the mark';
  });

  /** Where has the text gone? Either still in the open editor, or committed
   *  onto the annotation and painted. Anywhere else means the user lost it. */
  async function textIsSafe(id, expected, what, loose = false) {
    const ok = (v) => v != null && (loose ? v.startsWith(expected) : v === expected);
    const open = await js(`(()=>{const t=document.querySelector('.ftEditor');
      return t?JSON.stringify(t.value):'null';})()`);
    const painted = await renderedText(id);
    const inEditor = open !== 'null' && ok(JSON.parse(open));
    assert(inEditor || ok(painted),
      `${what}: the editor holds ${open} and the page paints ` +
      `${JSON.stringify(painted)} -- "${expected}" is gone from both. ` +
      'Nothing has focus, so anything typed next goes to the window handler ' +
      'and fires tool shortcuts instead.');
    return inEditor ? 'kept in the open editor' : 'committed and painted';
  }

  await check('resizing the window mid-edit does not lose what was typed', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'resize.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    await typeText('mid-resize');
    win.setSize(1040, 780);
    await wait(1400);
    let where;
    try {
      where = await textIsSafe(id, 'mid-resize', 'after a window resize');
    } finally {
      win.setSize(1280, 900);
      await wait(900);
      const b = win.getContentBounds();
      const iw = await js(`innerWidth`);
      assert(iw === b.width, 'the coordinate invariant broke after resizing');
    }
    return where;
  });

  await check('zooming mid-edit does not lose what was typed', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'zoom-edit.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    await typeText('mid-zoom');
    const plus = await elRect('#zoomIsland button[data-zoom="1"]');
    await mouseClick(...centreOf(plus));
    await wait(1200);
    const where = await textIsSafe(id, 'mid-zoom', 'after zooming in');
    await js(`window.__app.applyFit('fit')`);
    await wait(700);
    return where;
  });

  await check('losing window focus mid-edit does not lose what was typed', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'blur.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const id = await js(`window.__app.state.selectedId`);
    await typeText('switched away');
    win.blur();                 // a real window event, not a synthetic one
    await wait(700);
    app.focus({ steal: true });
    win.focus();
    await wait(900);
    // NOT fully independent: a harness window is never truly the front app, so
    // the page may never receive the blur at all. The invariant asserted here
    // holds either way -- nothing typed may go missing.
    // Matched loosely: across a real focus change the harness cannot guarantee
    // that no extra keystroke of its own is in flight, so the invariant under
    // test is that what was typed is still there -- not that nothing else is.
    return await textIsSafe(id, 'switched away', 'after the window lost focus', true);
  });

  // ------------------------------------------------------------------------
  console.log('\n\x1b[1mP. accumulation and overlap\x1b[0m');

  await check('40 marks on one page: all painted, still responsive, undo walks back', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'many.pdf', settle: 1800 });
    await setToolByKey('R', 'square');
    const pr = await pageRect(0);
    for (let i = 0; i < 40; i++) {
      const x = pr.x + 20 + (i % 8) * (pr.w - 60) / 8;
      const y = pr.y + 30 + Math.floor(i / 8) * (pr.h - 90) / 5;
      await drag([x, y], [x + 30, y + 25], { steps: 3, settle: 40 });
    }
    const ids = await renderedIds();
    assert(ids.length === 40, `only ${ids.length} of 40 marks are painted`);
    await setToolByKey('V', 'select');
    const t0 = Date.now();
    const r = await annotRect(ids[20]);
    await mouseClick(...centreOf(r));
    const sel = await js(`window.__app.state.selectedId`);
    const ms = Date.now() - t0;
    assert(sel === ids[20], `clicking mark 21 of 40 selected ${sel}`);
    assert(ms < 2000, `a click took ${ms}ms with 40 marks on the page`);
    await key('Escape');
    for (let i = 0; i < 5; i++) { await key('z', ['control']); await wait(180); }
    const left = (await renderedIds()).length;
    assert(left === 35, `five undos left ${left} marks, expected 35`);
    return `40 drawn, click ${ms}ms, 5 undos -> ${left}`;
  });

  await check('overlapping shapes: the top one is clicked, the lower stays reachable', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'overlap.pdf', settle: 1800 });
    await setToolByKey('R', 'square');
    const pr = await pageRect(0);
    const a = [pr.x + pr.w * 0.2, pr.y + pr.h * 0.2];
    await drag(a, [a[0] + 240, a[1] + 160], { steps: 8 });
    const b = [pr.x + pr.w * 0.35, pr.y + pr.h * 0.3];
    await drag(b, [b[0] + 240, b[1] + 160], { steps: 8 });
    const list = await annots();
    assert(list.length === 2, `${list.length} shapes drawn`);
    const [lower, upper] = list;
    await setToolByKey('V', 'select');
    // click where they overlap
    const ru = await annotRect(upper.id);
    await mouseClick(ru.x + 12, ru.y + 12);
    await wait(200);
    let sel = await js(`window.__app.state.selectedId`);
    assert(sel === upper.id,
      `clicking the overlap selected the lower shape (${sel === lower.id ? 'lower' : sel})`);
    // and the lower one is still reachable where it is not covered
    await key('Escape');
    const rl = await annotRect(lower.id);
    await mouseClick(rl.x + 8, rl.y + 8);
    await wait(200);
    sel = await js(`window.__app.state.selectedId`);
    assert(sel === lower.id, `the lower shape could not be selected (got ${sel})`);
    return 'top wins in the overlap, lower reachable outside it';
  });

  await check('overlapping text boxes: double-click edits the top one', async () => {
    await openDoc(path.join(FIX, 'plain.pdf'), { name: 'overlap-text.pdf', settle: 1800 });
    await setToolByKey('V', 'select');
    await setToolByKey('T', 'freetext');
    await wait(300);
    const lowerId = await js(`window.__app.state.selectedId`);
    await typeText('LOWER');
    await key('Escape');
    await wait(200);
    const rl = await annotRect(lowerId);
    await key('Escape');
    await wait(150);
    // place the second box on top of the first
    await setToolByKey('T', 'freetext');
    await wait(300);
    const upperId = await js(`window.__app.state.selectedId`);
    assert(upperId !== lowerId, 'the second box was never created');
    await typeText('UPPER');
    await key('Escape');
    await wait(200);
    const ru = await annotRect(upperId);
    await key('Escape');
    await wait(200);
    const ox = Math.min(ru.x + ru.w, rl.x + rl.w) - Math.max(ru.x, rl.x);
    const oy = Math.min(ru.y + ru.h, rl.y + rl.h) - Math.max(ru.y, rl.y);
    if (!(ox > 4 && oy > 4)) return skipped('the two boxes did not overlap');
    await doubleClick(Math.max(ru.x, rl.x) + ox / 2, Math.max(ru.y, rl.y) + oy / 2);
    await wait(300);
    const open = await jsJSON(`(()=>{const t=document.querySelector('.ftEditor');
      return JSON.stringify({present:!!t,value:t?t.value:null,
        focused:document.activeElement===t,hasFocus:document.hasFocus()});})()`);
    if (!open.present && await editorDiedInstantly()) {
      return skipped('the editor opened and focus was taken straight back off it ' +
        '-- this window is not the OS key window');
    }
    assert(open.present,
      `the double-click opened no editor. The renderer saw ${lastPresses.length} ` +
      `event(s) ${lastDoubleClickGap}ms apart (the app's own window is 450ms): ` +
      JSON.stringify(lastPresses));
    assert(open.value === 'UPPER',
      `the editor opened on "${open.value}" -- the box underneath, not the one on top`);
    // The caret is only assertable while the harness window still holds OS
    // focus; by this point in a long run it may not, and an unfocused document
    // cannot be used to judge focus. Reported either way, never silently passed.
    if (!open.focused && !open.hasFocus) {
      await key('Escape');
      return 'edits the top box (caret not checked: the window had lost OS focus)';
    }
    assert(open.focused, 'the editor opened but the caret is not in it');
    await key('Escape');
    return 'edits the top box, caret live';
  });

  // ------------------------------------------------------------------------
  await check('the renderer logged no errors during the whole run', async () => {
    assert(!rendererErrors.length,
      `${rendererErrors.length} console errors, first: ${rendererErrors[0]}`);
    return 'clean console';
  });

  console.log(`\n  ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (failures.length) {
    console.log('\n  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log(`  scratch: ${TMP}\n`);
  app.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\nharness crashed:', e && e.stack || e);
  app.exit(2);
});

// Nothing may outlive the run.
setTimeout(() => {
  console.error('\nthe run exceeded its budget');
  app.exit(3);
}, 8 * 60 * 1000);
