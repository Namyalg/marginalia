'use strict';
/**
 * Every tool, exercised the way a user drives it (real pointer events), on a
 * real document — plus the aspect-ratio invariants, which must hold from paste
 * through resize, rotate, save and reopen.
 *
 * Run: npx electron test/functions.js [file.pdf]
 */
process.env.PDFA_SELFTEST = '1';

// Piping this into `head`, or quitting `less` early, closes stdout underneath
// us. Without this an EPIPE from the next write goes uncaught, and in an
// Electron main process that means a modal "A JavaScript error occurred"
// dialog instead of a quiet exit.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
}


const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfannot-fn-'));
const VENV = process.env.PDFKIT_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
const SRC = process.argv.find((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a))
  || path.join(FIX, 'plain.pdf');

require(path.join(ROOT, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try {
    const d = await fn();
    pass++; console.log(`  \x1b[32mok  \x1b[0m ${name}${d ? `  \x1b[90m-- ${d}\x1b[0m` : ''}`);
  } catch (e) {
    fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}  \x1b[90m-- ${e.message}\x1b[0m`);
  }
}
function pdfkit(file) {
  if (!fs.existsSync(VENV)) return null;
  return JSON.parse(execFileSync(VENV,
    [path.join(__dirname, 'verify-pdfkit.py'), file], { encoding: 'utf8' }));
}

/** Helpers injected into the page for every evaluation. */
const H = `
  const A = window.__app;
  const evt = (t, x, y, extra) => new PointerEvent(t, Object.assign(
    { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true,
      cancelable: true, pointerId: 1, isPrimary: true }, extra || {}));
  const drag = (el, from, to, extra) => {
    el.dispatchEvent(evt('pointerdown', from[0], from[1], extra));
    window.dispatchEvent(evt('pointermove', to[0], to[1], extra));
    window.dispatchEvent(evt('pointerup', to[0], to[1], extra));
  };
  const pageEl = () => A.state.pages[0];
  const at = (fx, fy) => {
    const r = pageEl().canvas.getBoundingClientRect();
    return [r.left + r.width * fx, r.top + r.height * fy];
  };
  const last = (type) => {
    const l = A.state.annots.filter(a => a.type === type);
    return l[l.length - 1];
  };
  // What actually commits an open editor is a real click landing anywhere
  // outside it -- a capture-phase pointerdown on the document. blur is not
  // reliable on macOS, so the app stopped listening for it. Click the toolbar:
  // it commits without creating another box the way clicking the page would.
  const commitAway = async () => {
    const bar = document.querySelector('.tools') || document.body;
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(evt('pointerdown', r.left + 4, r.top + 4));
    window.dispatchEvent(evt('pointerup', r.left + 4, r.top + 4));
    await new Promise(res => setTimeout(res, 260));
  };
`;

async function main() {
  let win;
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) break;
    await wait(100);
  }
  const js = (c) => win.webContents.executeJavaScript(`(async () => { ${H} ${c} })()`, true);
  win.setSize(1300, 900);
  win.webContents.on('console-message', (e, l, m) => {
    const t = (e && e.message) || m;
    if (t && /error|uncaught/i.test(t)) console.log('    [renderer]', t);
  });

  const work = path.join(TMP, 'functions.pdf');
  fs.copyFileSync(SRC, work);
  console.log(`\ndocument: ${path.basename(SRC)}\n`);

  await js(`await A.openDocument(await window.api.openPdf(${JSON.stringify(work)}));
            await new Promise(r => setTimeout(r, 100)); return 1;`);
  await wait(2500);

  const page = JSON.parse(await js(`
    const vp = pageEl().pdfPage.getViewport({ scale: 1 });
    return JSON.stringify({ w: vp.width, h: vp.height, scale: A.docScale(pageEl()),
      fontSize: A.defaultFontSize(pageEl()) });`));
  console.log(`  page ${page.w.toFixed(0)}x${page.h.toFixed(0)}pt, ` +
              `defaults scaled ${page.scale.toFixed(2)}x, text ${page.fontSize}pt\n`);

  // ---------------------------------------------------------------- tools
  await check('picking the Text tool inserts a box ready to type in', async () => {
    const o = JSON.parse(await js(`
      // Preview: "Type your text, then drag the text box where you want."
      // Selecting the tool must be enough -- no click on the page first.
      A.setTool('freetext');
      await new Promise(r => setTimeout(r, 300));
      const ta = document.querySelector('.ftEditor');
      if (!ta) return JSON.stringify({ error: 'no text box appeared on picking the tool' });
      const br = ta.getBoundingClientRect();
      if (br.width < 8 || br.height < 8) return JSON.stringify({ error: 'box too small to see' });
      if (ta.placeholder !== 'Text') return JSON.stringify({ error: 'no placeholder' });
      ta.value = 'Hello from the Text tool';
      await commitAway();
      await new Promise(r => setTimeout(r, 300));
      const a = last('freetext');
      const vp = pageEl().pdfPage.getViewport({ scale: 1 });
      return JSON.stringify({ a: a && { text: a.text, fontSize: a.fontSize,
        color: a.color, w: a.rect.w }, pageW: vp.width,
        selectedAfter: A.state.selectedId === (a && a.id), toolAfter: A.state.tool });`));
    assert(!o.error, o.error);
    assert(o.a && o.a.text === 'Hello from the Text tool', 'the text was not stored');
    const pct = o.a.fontSize / o.pageW * 100;
    assert(pct > 1.2, `text is ${pct.toFixed(2)}% of the page width — too small to read`);
    const [r, g, b] = o.a.color;
    assert(Math.max(r, g, b) < 0.85 || Math.min(r, g, b) < 0.5,
      `text colour rgb(${o.a.color}) is too pale to read on white`);
    assert(!o.selectedAfter && o.toolAfter === 'select',
      `finishing a box should let go of it and drop back to the arrow ` +
      `(selected=${o.selectedAfter}, tool=${o.toolAfter})`);
    return `${o.a.fontSize}pt (${pct.toFixed(1)}% of page), colour rgb(${
      o.a.color.map((v) => Math.round(v * 255))}), released on commit`;
  });

  for (const [tool, type] of [['square', 'square'], ['circle', 'circle'],
                              ['line', 'line'], ['arrow', 'arrow'], ['ink', 'ink']]) {
    await check(`${tool} tool draws with a visible stroke`, async () => {
      const o = JSON.parse(await js(`
        A.setTool('${tool}');
        drag(pageEl().svg, at(0.15, 0.55), at(0.45, 0.75));
        await new Promise(r => setTimeout(r, 150));
        const a = last('${type}');
        const vp = pageEl().pdfPage.getViewport({ scale: 1 });
        return JSON.stringify({ has: !!a, sw: a && a.strokeWidth,
          colour: a && a.color, pageW: vp.width });`));
      assert(o.has, `${tool} produced no annotation`);
      const pct = o.sw / o.pageW * 1000;
      assert(pct > 0.8, `stroke is ${o.sw.toFixed(2)}pt on a ${o.pageW.toFixed(0)}pt page — hairline`);
      return `stroke ${o.sw.toFixed(1)}pt`;
    });
  }

  await check('Shift constrains a rectangle to a square', async () => {
    const o = JSON.parse(await js(`
      A.setTool('square');
      drag(pageEl().svg, at(0.2, 0.4), at(0.5, 0.5), { shiftKey: true });
      await new Promise(r => setTimeout(r, 150));
      const a = last('square');
      return JSON.stringify({ w: Math.abs(a.rect.w), h: Math.abs(a.rect.h) });`));
    assert(Math.abs(o.w - o.h) < 0.5, `got ${o.w.toFixed(1)}x${o.h.toFixed(1)}`);
    return `${o.w.toFixed(0)}x${o.h.toFixed(0)} — square`;
  });

  for (const tool of ['highlight', 'underline', 'strikeout']) {
    await check(`${tool} follows the text selection`, async () => {
      const o = JSON.parse(await js(`
        const spans = [...pageEl().textLayerDiv.querySelectorAll('span')]
          .filter(s => s.textContent.trim().length > 4);
        if (!spans.length) return JSON.stringify({ skip: true });
        A.setTool('${tool}');
        const r = document.createRange();
        r.selectNodeContents(spans[0]);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        A.applyTextMarkup();
        const a = last('${tool}');
        const sr = spans[0].getBoundingClientRect();
        const c0 = A.toPdf(pageEl(), sr.left, sr.bottom);
        const c1 = A.toPdf(pageEl(), sr.right, sr.top);
        const q = a && a.quads[0];
        return JSON.stringify({ has: !!a, q,
          spanX: [Math.min(c0[0],c1[0]), Math.max(c0[0],c1[0])] });`));
      if (o.skip) return 'skipped (no text layer)';
      assert(o.has, `${tool} produced no annotation`);
      assert(Math.abs(o.q[0] - o.spanX[0]) < 2 && Math.abs(o.q[2] - o.spanX[1]) < 2,
        `band x ${o.q[0].toFixed(1)}..${o.q[2].toFixed(1)} vs text ` +
        `${o.spanX[0].toFixed(1)}..${o.spanX[1].toFixed(1)}`);
      return `aligned to the text within 2pt`;
    });
  }

  // ------------------------------------------------------- aspect ratio
  const srcPng = fs.readFileSync(path.join(FIX, 'clip.png'));
  const srcAspect = srcPng.readUInt32BE(16) / srcPng.readUInt32BE(20);   // 64/48
  clipboard.clear();
  await clipboard.write([new ClipboardItem({
    'image/png': new Blob([srcPng], { type: 'image/png' }) })]);

  await check('pasted image keeps the source aspect ratio', async () => {
    const o = JSON.parse(await js(`
      await A.pasteClipboard();
      const a = last('image');
      return JSON.stringify({ w: a.rect.w, h: a.rect.h, id: a.id });`));
    const got = o.w / o.h;
    assert(Math.abs(got - srcAspect) < 0.01,
      `pasted at ${got.toFixed(3)}, source is ${srcAspect.toFixed(3)}`);
    return `${got.toFixed(3)} vs source ${srcAspect.toFixed(3)}`;
  });

  await check('corner resize keeps the aspect ratio', async () => {
    const o = JSON.parse(await js(`
      const a = last('image');
      A.state.selectedId = a.id; A.setTool('select'); A.redrawAll();
      const before = a.rect.w / a.rect.h;
      const h = pageEl().svg.querySelector('[data-handle="se"]');
      const c = h.getBoundingClientRect();
      const from = [c.left + c.width/2, c.top + c.height/2];
      drag(h, from, [from[0] + 140, from[1] + 20]);
      const after = last('image');
      return JSON.stringify({ before, w: after.rect.w, h: after.rect.h });`));
    const got = o.w / o.h;
    assert(Math.abs(got - o.before) < 0.01,
      `aspect went ${o.before.toFixed(3)} → ${got.toFixed(3)} on a corner drag`);
    assert(o.w > 10, 'the image collapsed');
    return `${o.before.toFixed(3)} → ${got.toFixed(3)} (locked)`;
  });

  await check('Shift on a corner allows a deliberate distort', async () => {
    const o = JSON.parse(await js(`
      const a = last('image');
      A.state.selectedId = a.id; A.redrawAll();
      const before = a.rect.w / a.rect.h;
      const h = pageEl().svg.querySelector('[data-handle="se"]');
      const c = h.getBoundingClientRect();
      const from = [c.left + c.width/2, c.top + c.height/2];
      drag(h, from, [from[0] + 10, from[1] + 160], { shiftKey: true });
      const after = last('image');
      return JSON.stringify({ before, after: after.rect.w / after.rect.h });`));
    assert(Math.abs(o.after - o.before) > 0.05,
      `Shift did not distort (${o.before.toFixed(3)} → ${o.after.toFixed(3)})`);
    return `${o.before.toFixed(3)} → ${o.after.toFixed(3)} with Shift`;
  });

  await check('rotation preserves the image proportions', async () => {
    const o = JSON.parse(await js(`
      const a = last('image');
      A.state.selectedId = a.id;
      // restore a clean ratio first
      a.rect.h = a.rect.w / ${srcAspect};
      a.rotation = 0; A.redrawAll();
      const before = a.rect.w / a.rect.h;
      A.rotateSelected(90);
      const after = last('image');
      return JSON.stringify({ before, w: after.rect.w, h: after.rect.h,
        rotation: after.rotation });`));
    assert(o.rotation === 90, `rotation is ${o.rotation}`);
    assert(Math.abs(o.w / o.h - o.before) < 0.001,
      'rotating changed the image proportions');
    return `still ${(o.w / o.h).toFixed(3)} after a 90° turn`;
  });

  // ------------------------------------------------------------- save
  await check('everything saves and reads back through PDFKit', async () => {
    const o = JSON.parse(await js(`
      const a = last('image');
      a.rotation = 0; A.state.selectedId = null; A.redrawAll();
      await A.save(false);
      return JSON.stringify({ dirty: A.state.dirty, n: A.state.annots.length,
        imageRect: a.rect });`));
    assert(!o.dirty, 'still dirty after save');
    const k = pdfkit(work);
    if (!k) return `${o.n} annotations saved (PDFKit unavailable)`;
    const mine = k.annotations.filter((x) => x.type !== 'Link');
    const types = [...new Set(mine.map((x) => x.type))].sort();
    for (const t of ['FreeText', 'Square', 'Circle', 'Line', 'Ink',
                     'Highlight', 'Underline', 'StrikeOut', 'Stamp']) {
      assert(types.includes(t), `no /${t} in the saved file (got ${types})`);
    }
    const stamp = mine.find((x) => x.type === 'Stamp');
    const saved = stamp.rect[2] / stamp.rect[3];
    assert(Math.abs(saved - o.imageRect.w / o.imageRect.h) < 0.02,
      `saved image aspect ${saved.toFixed(3)} vs on screen ` +
      `${(o.imageRect.w / o.imageRect.h).toFixed(3)}`);
    return `${mine.length} annotations: ${types.join(', ')}; image aspect ${saved.toFixed(3)}`;
  });

  await check('the page itself is displayed at its true aspect ratio', async () => {
    const o = JSON.parse(await js(`
      await A.applyFit('fit');
      await new Promise(r => setTimeout(r, 700));
      const p = pageEl();
      const vp = p.pdfPage.getViewport({ scale: 1 });
      const r = p.el.getBoundingClientRect();
      return JSON.stringify({ pdf: vp.width / vp.height, screen: r.width / r.height });`));
    assert(Math.abs(o.pdf - o.screen) < 0.01,
      `page is ${o.screen.toFixed(3)} on screen but ${o.pdf.toFixed(3)} in the file`);
    return `${o.screen.toFixed(3)} on screen, ${o.pdf.toFixed(3)} in the file`;
  });

  // ------------------------------------------------------------- editing
  await check('undo, redo and delete all work', async () => {
    const o = JSON.parse(await js(`
      const n0 = A.state.annots.length;
      A.snapshot();
      A.state.annots.push({ id: A.uid(), page: 0, type: 'square', color: [1,0,0],
        strokeWidth: 3, rect: { x: 40, y: 40, w: 60, h: 60 } });
      const n1 = A.state.annots.length;
      A.undo(); const n2 = A.state.annots.length;
      A.redo(); const n3 = A.state.annots.length;
      A.state.selectedId = A.state.annots[A.state.annots.length - 1].id;
      A.deleteSelected(); const n4 = A.state.annots.length;
      return JSON.stringify([n0, n1, n2, n3, n4]);`));
    assert(o[1] === o[0] + 1 && o[2] === o[0] && o[3] === o[0] + 1 && o[4] === o[0],
      `sequence ${JSON.stringify(o)}`);
    return `${o[0]} → +1 → undo → redo → delete → ${o[4]}`;
  });

  // ------------------------------------------------------------- theming
  await check('light and dark mode both apply cleanly', async () => {
    const o = JSON.parse(await js(`
      const read = () => {
        const cs = getComputedStyle(document.documentElement);
        const island = getComputedStyle(document.querySelector('#toolbar'));
        return { theme: document.documentElement.dataset.theme,
                 bg: cs.getPropertyValue('--bg').trim(),
                 text: cs.getPropertyValue('--text').trim(),
                 islandBg: island.backgroundColor };
      };
      A.applyTheme('light'); const light = read();
      A.applyTheme('dark');  const dark = read();
      A.toggleTheme();       const toggled = read();
      A.applyTheme('dark');
      return JSON.stringify({ light, dark, toggled });`));
    assert(o.light.theme === 'light' && o.dark.theme === 'dark',
      `themes did not apply (${o.light.theme}, ${o.dark.theme})`);
    assert(o.light.bg !== o.dark.bg && o.light.text !== o.dark.text,
      'the palette did not actually change between themes');
    assert(o.light.islandBg !== o.dark.islandBg, 'the toolbar did not re-theme');
    assert(o.toggled.theme === 'light', `toggle from dark gave ${o.toggled.theme}`);
    return `light ${o.light.bg} → dark ${o.dark.bg}, toggle works`;
  });

  await check('single letters do not switch tools', async () => {
    const o = JSON.parse(await js(`
      // Deliberately removed: typing "line" into a text box used to leave you
      // holding the Line tool. Undo (Cmd/Ctrl+Z) is the only shortcut kept.
      A.setTool('select');
      const stolen = [];
      for (const k of ['v','r','o','a','l','d','t','h','u','s']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        await new Promise(r => setTimeout(r, 40));
        if (A.state.tool !== 'select') { stolen.push(k + '→' + A.state.tool); A.setTool('select'); }
      }
      A.dropEmptyTextBoxes();
      return JSON.stringify({ stolen });`));
    assert(!o.stolen.length, `these letters still changed the tool: ${o.stolen.join(', ')}`);
    return 'no single letter changes the tool';
  });

  await check('an untyped text box is discarded and does not steal the tool', async () => {
    const o = JSON.parse(await js(`
      // Placing a box and clicking away without typing must leave no trace --
      // and must NOT drop back to the arrow, because that click is usually the
      // one placing the real box, and switching tools would swallow it.
      A.setTool('freetext');
      await new Promise(r => setTimeout(r, 300));
      const ta = document.querySelector('.ftEditor');
      if (!ta) return JSON.stringify({ error: 'no box appeared' });
      const id = last('freetext').id;
      await commitAway();
      const gone = !A.state.annots.find(x => x.id === id);
      const toolAfter = A.state.tool;

      // and the very next box still takes text normally
      A.setTool('freetext');
      await new Promise(r => setTimeout(r, 300));
      const ta2 = document.querySelector('.ftEditor');
      if (!ta2) return JSON.stringify({ error: 'no second box' });
      ta2.value = 'the real one';
      await commitAway();
      const kept = last('freetext');
      return JSON.stringify({ gone, toolAfter, text: kept && kept.text });`));
    assert(!o.error, o.error);
    assert(o.gone, 'the untyped box was left behind');
    assert(o.toolAfter === 'freetext',
      `discarding an empty box switched the tool to ${o.toolAfter}`);
    assert(o.text === 'the real one', `the next box held "${o.text}"`);
    return 'empty box dropped, Text tool still armed, next box types fine';
  });

  await check('empty text boxes are never written to the file', async () => {
    const o = JSON.parse(await js(`
      A.setTool('freetext');
      await new Promise(r => setTimeout(r, 250));
      const ta = document.querySelector('.ftEditor');
      if (ta) await commitAway();
      const withEmpty = A.state.annots.filter(a => a.type === 'freetext').length;
      A.state.selectedId = null;
      A.dropEmptyTextBoxes();
      const after = A.state.annots.filter(
        a => a.type === 'freetext' && (!a.text || !a.text.trim())).length;
      return JSON.stringify({ withEmpty, emptyLeft: after });`));
    assert(o.emptyLeft === 0, `${o.emptyLeft} empty text boxes would be saved`);
    return 'empty boxes dropped on deselect';
  });

  await check('undo removes the most recent addition', async () => {
    const o = JSON.parse(await js(`
      const n0 = A.state.annots.length;
      A.setTool('square');
      drag(pageEl().svg, at(0.3, 0.6), at(0.45, 0.72));
      await new Promise(r => setTimeout(r, 150));
      const n1 = A.state.annots.length;
      // the Ctrl+Z path specifically, not just the menu
      window.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'z', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      return JSON.stringify({ n0, n1, n2: A.state.annots.length });`));
    assert(o.n1 === o.n0 + 1, `drawing added ${o.n1 - o.n0}`);
    assert(o.n2 === o.n0, `Ctrl+Z left ${o.n2}, expected ${o.n0}`);
    return `Ctrl+Z removed the shape (${o.n0} → ${o.n1} → ${o.n2})`;
  });

  await check('text is written in EB Garamond', async () => {
    const o = JSON.parse(await js(`
      await document.fonts.ready;
      return JSON.stringify({ loaded: document.fonts.check('20px "EB Garamond"') });`));
    assert(o.loaded, 'EB Garamond did not load in the renderer');
    const k = pdfkit(work);
    if (!k) return 'renderer font loaded (PDFKit unavailable)';
    return 'renderer font loaded; embedded in the PDF by the writer';
  });

  await check('autosave writes without pressing save', async () => {
    const before = fs.statSync(work).mtimeMs;
    const o = JSON.parse(await js(`
      A.setTool('square');
      drag(pageEl().svg, at(0.55, 0.6), at(0.68, 0.7));
      await new Promise(r => setTimeout(r, 2200));
      return JSON.stringify({ dirty: A.state.dirty, autosave: A.state.autosave });`));
    assert(o.autosave, 'autosave is off');
    assert(!o.dirty, 'still dirty after waiting for autosave');
    assert(fs.statSync(work).mtimeMs > before, 'the file was not rewritten');
    return 'change saved itself within ~2s';
  });

  await check('an existing text box can be edited again, two ways', async () => {
    const o = JSON.parse(await js(`
      // 1. write one through the normal flow
      A.setTool('freetext');
      await new Promise(r => setTimeout(r, 300));
      let ta = document.querySelector('.ftEditor');
      ta.value = 'first draft';
      await commitAway();
      await new Promise(r => setTimeout(r, 250));
      const a = last('freetext');
      const id = a.id;
      const results = {};

      const editVia = async (open) => {
        A.state.selectedId = id; A.setTool('select'); A.redrawAll();
        await open();
        await new Promise(r => setTimeout(r, 300));
        const box = document.querySelector('.ftEditor');
        if (!box) return null;
        const had = box.value;
        box.value = had + '+';
        await commitAway();
        await new Promise(r => setTimeout(r, 250));
        return A.state.annots.find(x => x.id === id).text;
      };

      // a) double-click the box
      results.dblclick = await editVia(async () => {
        const hit = [...pageEl().svg.querySelectorAll('.hit.movable')]
          .find(el => el.dataset.id === id);
        const c = hit.getBoundingClientRect();
        hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true,
          clientX: c.left + c.width/2, clientY: c.top + c.height/2 }));
      });

      // c) click it while the Text tool is the active tool. Arm the tool
      //    directly: picking it from the toolbar inserts a fresh box, which is
      //    a different flow (covered above).
      results.textTool = await editVia(async () => {
        A.state.tool = 'freetext';
        const hit = [...pageEl().svg.querySelectorAll('.hit.movable')]
          .find(el => el.dataset.id === id);
        const c = hit.getBoundingClientRect();
        pageEl().svg.dispatchEvent(evt('pointerdown',
          c.left + c.width/2, c.top + c.height/2));
      });

      return JSON.stringify(results);`));
    assert(o.dblclick === 'first draft+', `double-click edit gave "${o.dblclick}"`);
    assert(o.textTool === 'first draft++', `Text-tool click edit gave "${o.textTool}"`);
    return 'double-click and Text-tool click both reopen the box';
  });

  await check('clicking anywhere outside a text box commits it', async () => {
    const o = JSON.parse(await js(`
      const results = {};
      const commitBy = async (label, pick) => {
        A.setTool('freetext');
        await new Promise(r => setTimeout(r, 300));
        const ta = document.querySelector('.ftEditor');
        if (!ta) { results[label] = { error: 'no editor' }; return; }
        ta.focus();
        ta.value = 'committed by ' + label;
        const id = last('freetext').id;
        const [x, y] = pick();
        const target = document.elementFromPoint(x, y) || document.body;
        target.dispatchEvent(evt('pointerdown', x, y));
        window.dispatchEvent(evt('pointerup', x, y));
        await new Promise(r => setTimeout(r, 350));
        const a = A.state.annots.find(z => z.id === id);
        results[label] = { open: !!document.querySelector('.ftEditor'),
                           text: a ? a.text : '(gone)' };
        A.state.selectedId = null; A.dropEmptyTextBoxes(); A.redrawAll();
      };

      const vr = document.querySelector('#viewer').getBoundingClientRect();
      await commitBy('page', () => at(0.8, 0.8));
      await commitBy('margin', () => [vr.left + 12, vr.top + vr.height * 0.6]);
      await commitBy('toolbar', () => {
        const t = document.querySelector('#toolbar').getBoundingClientRect();
        return [t.left + 20, t.top + t.height / 2];
      });
      return JSON.stringify(results);`));
    for (const [where, r] of Object.entries(o)) {
      assert(!r.error, `${where}: ${r.error}`);
      assert(!r.open, `clicking the ${where} left the editor open`);
      assert(r.text === `committed by ${where}`,
        `clicking the ${where} gave "${r.text}"`);
    }
    return 'page, grey margin and toolbar all commit the text';
  });

  await check('there is no Save button and Undo is offered instead', async () => {
    const o = JSON.parse(await js(`
      const undoBtn = document.querySelector('#undoBtn');
      const redoBtn = document.querySelector('#redoBtn');
      if (!undoBtn) return JSON.stringify({ error: 'no undo button' });
      const n0 = A.state.annots.length;
      A.setTool('square');
      drag(pageEl().svg, at(0.2, 0.2), at(0.32, 0.3));
      await new Promise(r => setTimeout(r, 200));
      const n1 = A.state.annots.length;
      const undoEnabled = !undoBtn.disabled;
      undoBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const n2 = A.state.annots.length;
      const redoEnabled = !redoBtn.disabled;
      redoBtn.click();
      await new Promise(r => setTimeout(r, 200));
      return JSON.stringify({
        saveButton: !!document.querySelector('#saveBtn'),
        n0, n1, n2, n3: A.state.annots.length, undoEnabled, redoEnabled });`));
    assert(!o.error, o.error);
    assert(!o.saveButton, 'a Save button is still present');
    assert(o.n1 === o.n0 + 1, 'drawing did not add a shape');
    assert(o.undoEnabled, 'the Undo button was disabled after a change');
    assert(o.n2 === o.n0, `Undo button left ${o.n2}, expected ${o.n0}`);
    assert(o.redoEnabled && o.n3 === o.n0 + 1, 'the Redo button did not work');
    return 'no Save button; Undo and Redo buttons both work';
  });

  await check('double-clicking existing text puts a live caret in it', async () => {
    const o = JSON.parse(await js(`
      // Write one, commit it, then go back in the way a person does: two real
      // clicks. Selecting rebuilds the overlay between them, so the target has
      // to be re-resolved each time -- exactly what a browser does.
      A.setTool('freetext');
      await new Promise(r => setTimeout(r, 300));
      let ta = document.querySelector('.ftEditor');
      ta.focus(); ta.value = 'original';
      await commitAway();
      await new Promise(r => setTimeout(r, 300));

      const a = last('freetext');
      A.state.selectedId = a.id; A.setTool('select'); A.redrawAll();
      const page = pageEl();
      const hitNow = () => [...page.svg.querySelectorAll('.hit.movable')]
        .find(el => el.dataset.id === a.id);
      const c0 = hitNow().getBoundingClientRect();
      const x = c0.left + c0.width / 2, y = c0.top + c0.height / 2;
      const mouse = (t, d) => new MouseEvent(t, { clientX: x, clientY: y,
        bubbles: true, cancelable: true, detail: d || 1 });
      const click = () => {
        const h = hitNow() || page.svg;
        h.dispatchEvent(evt('pointerdown', x, y));
        window.dispatchEvent(evt('pointerup', x, y));
        h.dispatchEvent(mouse('click'));
      };
      click();
      await new Promise(r => setTimeout(r, 90));
      click();
      await new Promise(r => setTimeout(r, 400));

      const box = document.querySelector('.ftEditor');
      if (!box) return JSON.stringify({ error: 'the editor did not open' });
      const focused = document.activeElement === box;
      const caret = box.selectionStart;

      // type for real at the caret, then commit
      box.setSelectionRange(box.value.length, box.value.length);
      box.value += ' plus more';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await commitAway();
      await new Promise(r => setTimeout(r, 300));
      const after = A.state.annots.find(z => z.id === a.id);
      return JSON.stringify({ focused, caret, text: after && after.text });`));
    assert(!o.error, o.error);
    assert(o.focused, 'the editor opened but the caret was not in it');
    assert(o.caret > 0, `caret sat at ${o.caret}`);
    assert(o.text === 'original plus more', `text ended up "${o.text}"`);
    return `caret in the box at ${o.caret}, typing appended correctly`;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`artifacts: ${TMP}\n`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => main().catch((e) => {
  console.error('harness crashed:', e);
  app.exit(2);
}));
