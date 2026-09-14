'use strict';
/**
 * The promise this app makes: close it, open the same PDF again, and every
 * mark is still yours — draggable, retypable, deletable.
 *
 * Done the way a person would: real mouse and key events, one mark of every
 * kind, and a genuine app restart between phases (each phase is a separate
 * launch, because "reopen" only means something if the process went away).
 *
 *   npx electron test/reopen.js --phase 1 --work <file>
 *   scripts/run-reopen-test.sh [source.pdf]     # runs all three in order
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
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const PHASE = Number(arg('phase', '1'));
const WORK = arg('work');
const VENV = process.env.PDFKIT_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
const STATE = (n) => `${WORK}.state${n}.json`;

require(path.join(ROOT, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (n, d) => console.log(`  \x1b[32mok  \x1b[0m ${n}${d ? `  \x1b[90m-- ${d}\x1b[0m` : ''}`);
const bad = (n, d) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${n}  \x1b[90m-- ${d}\x1b[0m`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));

app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) break;
    await wait(100);
  }
  win.show(); win.focus(); win.setSize(1280, 920);
  await wait(600);

  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const J = async (c) => JSON.parse(await js(c));

  const click = async (x, y, n = 1) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: n });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: n });
    await wait(170);
  };
  const drag = async (a, b, steps = 14) => {
    wc.sendInputEvent({ type: 'mouseMove', x: a[0], y: a[1] });
    wc.sendInputEvent({ type: 'mouseDown', x: a[0], y: a[1], button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      wc.sendInputEvent({ type: 'mouseMove', button: 'left', buttons: 1,
        x: Math.round(a[0] + (b[0] - a[0]) * i / steps),
        y: Math.round(a[1] + (b[1] - a[1]) * i / steps) });
      await wait(20);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: b[0], y: b[1], button: 'left', clickCount: 1 });
    await wait(300);
  };
  const type = async (t) => {
    for (const ch of t) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
      await wait(30);
    }
  };
  const tool = async (id) => {
    const p = await J(`(() => { const b = document.querySelector('[data-tool="${id}"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify([Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]);})()`);
    await click(p[0], p[1]);
    await wait(120);
  };
  const pagePt = async (fx, fy) => J(`(() => {
    const r = window.__app.state.pages[0].canvas.getBoundingClientRect();
    return JSON.stringify([Math.round(r.left + r.width*${fx}),
                           Math.round(r.top + r.height*${fy})]);})()`);
  /**
   * A spot on page 0 with no existing mark under it and no floating UI over
   * it. A real document is already covered in marks; dropping a new one on top
   * of an old one edits the old one instead, which is correct behaviour and
   * useless for this test.
   */
  const blankPt = async (used = []) => {
    for (let fy = 0.28; fy <= 0.80; fy += 0.06) {
      for (let fx = 0.30; fx <= 0.86; fx += 0.06) {
        const p = await pagePt(fx, fy);
        const clear = await js(`(() => {
          const A = window.__app, page = A.state.pages[0];
          const el = document.elementFromPoint(${p[0]}, ${p[1]});
          if (!el || !page.el.contains(el)) return 'false';   // UI is over it
          return String(!A.annotationAt(page, ${p[0]}, ${p[1]}));})()`);
        if (clear !== 'true') continue;
        if (used.some(([ux, uy]) => Math.abs(ux - p[0]) < 150 && Math.abs(uy - p[1]) < 110)) continue;
        used.push(p);
        return p;
      }
    }
    return pagePt(0.6, 0.5);
  };

  const openDoc = async (file, settle = 2600) => {
    await js(`(async () => window.__app.openDocument(
      await window.api.openPdf(${JSON.stringify(file)})))()`);
    await wait(settle);
  };
  /** Every mark, with its page and bounding box in PDF points. */
  const marks = () => J(`(() => JSON.stringify(window.__app.state.annots.map(a => {
      const b = window.__app.annotBounds(a) || { x0:0, y0:0, x1:0, y1:0 };
      return { id: a.id, type: a.type, page: a.page, text: a.text || null,
               x0: Math.round(b.x0), y0: Math.round(b.y0),
               x1: Math.round(b.x1), y1: Math.round(b.y1) };
    })))()`);
  /**
   * Find the mark we left behind. A real document has many marks of each kind,
   * so position alone is not enough -- text has to match its words too, and
   * the tolerance allows for the rounding a save-and-reload introduces.
   */
  const locate = (list, want) => {
    const near = list.filter((m) => m.type === want.type && m.page === want.page &&
      Math.abs(m.x0 - want.x0) < 10 && Math.abs(m.y0 - want.y0) < 10);
    if (want.text != null) return near.find((m) => m.text === want.text) || null;
    return near[0] || null;
  };
  /** Screen centre of a mark, scrolling its page into view first. */
  const centre = async (id) => {
    await js(`(() => { const A = window.__app;
      const a = A.state.annots.find(x => x.id === ${JSON.stringify(id)});
      if (a) A.state.pages[a.page].el.scrollIntoView({ block: 'center' });
      return 1; })()`);
    await wait(800);
    return J(`(() => { const A = window.__app;
      const a = A.state.annots.find(x => x.id === ${JSON.stringify(id)});
      const page = A.state.pages[a.page], b = A.viewBox(page, a);
      const r = page.canvas.getBoundingClientRect();
      const sx = r.width/page.viewport.width, sy = r.height/page.viewport.height;
      return JSON.stringify([Math.round(r.left + (b.x + b.w/2)*sx),
                             Math.round(r.top + (b.y + b.h/2)*sy)]);})()`);
  };

  // ================================================================ phase 1
  if (PHASE === 1) {
    console.log('\n\x1b[1mphase 1 — draw one of everything, then quit\x1b[0m');
    const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'clip.png'));
    clipboard.clear();
    await clipboard.write([new ClipboardItem({
      'image/png': new Blob([png], { type: 'image/png' }) })]);

    await openDoc(WORK);
    await js(`window.__app.applyFit('fit')`);
    // Fitting re-renders every page; give the first one time to actually be
    // there before aiming at it, or the opening drag lands on nothing.
    await wait(1800);
    await js(`(async () => { await window.__app.renderPageContent(
      window.__app.state.pages[0]); return 1; })()`);
    await wait(500);

    // The first click into an unfocused window is consumed by focusing it.
    await tool('select');
    await click(...(await pagePt(0.5, 0.9)));
    await wait(200);

    const before = (await marks()).length;

    // Each mark goes on a patch of page with nothing already there.
    const used = [];
    for (const [id, steps] of [['square'], ['circle'], ['arrow'], ['line'], ['ink', 10]]) {
      const from = await blankPt(used);
      const n0 = (await marks()).length;
      await tool(id);
      await wait(200);
      await drag(from, [from[0] + 130, from[1] + 70], steps || 14);
      await wait(200);
      if ((await marks()).length === n0) bad(`${id}: drawing it`, 'the drag produced no mark');
    }

    await tool('freetext');
    await wait(250);
    await click(...(await blankPt(used)));
    await wait(250);
    await type('hello world');
    await click(...(await pagePt(0.92, 0.95)));
    await wait(350);

    // Paste lands on the page you are looking at, which is correct behaviour --
    // but the click that committed the text box sat near the bottom of page 1,
    // scrolling page 2 into view, so the image went there instead. Come back to
    // the top first so this phase always builds its marks on the same page.
    await js(`document.querySelector('#viewer').scrollTop = 0`);
    await wait(500);
    await js(`window.__app.pasteClipboard()`);
    await wait(900);
    await js(`window.__app.state.selectedId = null; window.__app.redrawAll()`);
    await js(`window.__app.save(false)`);
    await wait(1600);

    const made = (await marks()).filter((m) => m.page === 0);
    const kinds = ['square', 'circle', 'arrow', 'line', 'ink', 'freetext', 'image'];
    const mine = kinds.map((k) => {
      const m = made.filter((x) => x.type === k).slice(-1)[0];
      // the text box is identified by its words as well as its position
      return m && k === 'freetext' ? { ...m, text: 'hello world' } : m;
    }).filter(Boolean);
    fs.writeFileSync(STATE(1), JSON.stringify({ before, mine }));

    check('every kind of mark was made', mine.length === kinds.length,
      mine.map((m) => m.type).join(', '));
    check('they reached the file', (await marks()).length > before,
      `${before} → ${(await marks()).length} marks`);
  }

  // ================================================================ phase 2
  if (PHASE === 2) {
    console.log('\n\x1b[1mphase 2 — fresh launch: move and edit each of them\x1b[0m');
    const prev = JSON.parse(fs.readFileSync(STATE(1), 'utf8'));
    await openDoc(WORK);
    await js(`window.__app.applyFit('fit')`);
    await wait(900);

    const now = await marks();
    const readOnly = await js(`String(window.__app.state.readOnlyMarks)`);
    check('the file reopened with its marks editable', readOnly === 'false',
      `read-only: ${readOnly}, ${now.length} marks in the editor`);

    const moved = [];
    for (const want of prev.mine) {
      const found = locate(now, want);
      if (!found) { bad(`${want.type}: came back after reopening`, 'not found in the editor'); continue; }
      if (want.type === 'freetext') continue;             // handled below

      await tool('select');
      const at = await centre(found.id);
      await drag(at, [at[0] - 90, at[1] - 60], 14);
      const after = (await marks()).find((m) => m.id === found.id);
      const dx = after.x0 - found.x0, dy = after.y0 - found.y0;
      check(`${want.type}: can be dragged after reopening`,
        Math.abs(dx) > 5 || Math.abs(dy) > 5,
        `moved ${dx}, ${dy} pt`);
      moved.push({ type: want.type, page: after.page, x0: after.x0, y0: after.y0 });
    }

    // the text box: double-click it and keep typing
    const wantText = prev.mine.find((m) => m.type === 'freetext');
    const foundText = wantText && locate(now, wantText);
    if (!foundText) {
      const near = now.filter((m) => m.type === 'freetext' &&
        Math.abs(m.x0 - wantText.x0) < 60 && Math.abs(m.y0 - wantText.y0) < 60);
      bad('freetext: came back after reopening',
        `wanted "${wantText.text}" at ${wantText.x0},${wantText.y0} on page ${wantText.page}; ` +
        `nearby: ${JSON.stringify(near.map((m) => ({ t: m.text, x: m.x0, y: m.y0, p: m.page })))}`);
    }
    else {
      await tool('select');
      const at = await centre(foundText.id);
      await click(at[0], at[1], 1);
      await wait(130);
      await click(at[0], at[1], 2);
      await wait(500);
      const ed = await J(`(() => { const ta = document.querySelector('.ftEditor');
        return JSON.stringify({ open: !!ta, focused: !!ta && document.activeElement === ta,
          value: ta ? ta.value : null, caret: ta ? ta.selectionStart : null });})()`);
      check('freetext: double-click reopens it with the old words and a live caret',
        ed.open && ed.focused && ed.value === 'hello world',
        `editor holds "${ed.value}", caret ${ed.caret}`);
      if (ed.open) {
        await type(' again');
        await click(...(await pagePt(0.93, 0.96)));
        await wait(400);
      }
      const after = (await marks()).find((m) => m.id === foundText.id);
      check('freetext: the new words stuck', after && after.text === 'hello world again',
        `"${after && after.text}"`);
      moved.push({ type: 'freetext', page: after.page, x0: after.x0, y0: after.y0,
                   text: after.text });
    }

    await js(`window.__app.save(false)`);
    await wait(1700);
    const total = (await marks()).length;
    fs.writeFileSync(STATE(2), JSON.stringify({ moved, total }));
    check('nothing was duplicated by editing and saving', total === now.length,
      `${now.length} before, ${total} after`);
  }

  // ================================================================ phase 3
  if (PHASE === 3) {
    console.log('\n\x1b[1mphase 3 — fresh launch again: did all of it stick?\x1b[0m');
    const prev = JSON.parse(fs.readFileSync(STATE(2), 'utf8'));
    await openDoc(WORK);
    const now = await marks();

    check('still editable on the second reopen',
      (await js(`String(window.__app.state.readOnlyMarks)`)) === 'false',
      `${now.length} marks`);
    check('the file did not grow', now.length === prev.total,
      `${prev.total} then, ${now.length} now`);

    for (const want of prev.moved) {
      const found = locate(now, want);
      check(`${want.type}: stayed where it was put`, !!found,
        found ? `at ${found.x0},${found.y0}` : `nothing of that kind near ${want.x0},${want.y0}`);
      if (found && want.text) {
        check('freetext: kept its edited words', found.text === want.text,
          `"${found.text}"`);
      }
    }

    if (fs.existsSync(VENV)) {
      const kit = JSON.parse(execFileSync(VENV,
        [path.join(__dirname, 'verify-pdfkit.py'), WORK], { encoding: 'utf8' }));
      const mine = kit.annotations.filter((a) => a.type !== 'Link');
      check('the file itself holds them, read by PDFKit', mine.length === prev.total,
        `${mine.length} annotations`);
    }
  }

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall good\x1b[0m\n');
  app.exit(failures ? 1 : 0);
});
