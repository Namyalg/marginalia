'use strict';
/**
 * The first-minute checks: does the document fit on screen, does it stay fitted
 * when the window changes, does scrolling a long document work, and do
 * annotations still land correctly when the zoom is not 100%.
 *
 * These are the things a user hits before any of the deeper behaviour matters.
 *
 * Run: npx electron test/sanity.js [file.pdf]
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

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfannot-sanity-'));
const SRC = process.argv.find((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a))
  || path.join(ROOT, 'test', 'fixtures', 'plain.pdf');

require(path.join(ROOT, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try {
    const d = await fn();
    pass++; console.log(`  \x1b[32mok  \x1b[0m ${name}${d ? '  \x1b[90m-- ' + d + '\x1b[0m' : ''}`);
  } catch (e) {
    fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}  \x1b[90m-- ${e.message}\x1b[0m`);
  }
}

async function main() {
  let win;
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) break;
    await wait(100);
  }
  const js = (c) => win.webContents.executeJavaScript(c, true);
  win.webContents.on('console-message', (e, l, m) => {
    const t = (e && e.message) || m;
    if (t && /error|failed/i.test(t)) console.log('    [renderer]', t);
  });

  const work = path.join(TMP, 'sanity.pdf');
  fs.copyFileSync(SRC, work);
  win.setSize(1280, 900);
  await wait(300);

  console.log(`\ndocument: ${path.basename(SRC)}\n`);

  await js(`(async () => window.__app.openDocument(
    await window.api.openPdf(${JSON.stringify(work)})))()`);
  await wait(2500);

  const geom = () => js(`(() => {
    const A = window.__app, p = A.state.pages[0];
    const v = document.querySelector('#viewer');
    const pr = p.el.getBoundingClientRect(), vr = v.getBoundingClientRect();
    return JSON.stringify({
      mode: A.state.zoomMode, scale: A.state.scale,
      pageW: pr.width, pageH: pr.height,
      viewW: vr.width, viewH: vr.height,
      clientW: v.clientWidth, clientH: v.clientHeight,
      pages: A.state.pages.length,
      label: document.querySelector('#zoomLabel').textContent,
      numPages: A.state.doc.numPages,
    });
  })()`).then(JSON.parse);

  await check('the document opens fitted to the window', async () => {
    const g = await geom();
    assert(g.mode === 'fit', `zoom mode is "${g.mode}"`);
    assert(g.pageW <= g.clientW + 1,
      `page is ${g.pageW.toFixed(0)}px wide in a ${g.clientW}px viewport`);
    assert(g.pageH <= g.clientH + 1,
      `page is ${g.pageH.toFixed(0)}px tall in a ${g.clientH}px viewport`);
    // and it should actually fill the space, not sit tiny in the middle
    const fill = Math.max(g.pageW / g.clientW, g.pageH / g.clientH);
    assert(fill > 0.9, `page only fills ${(fill * 100).toFixed(0)}% of the window`);
    return `${g.numPages} pages, ${g.pageW.toFixed(0)}x${g.pageH.toFixed(0)}px ` +
           `in ${g.clientW}x${g.clientH}, ${g.label}`;
  });

  await check('resizing the window re-fits the page', async () => {
    win.setSize(900, 1000);
    await wait(900);
    const g = await geom();
    assert(g.pageW <= g.clientW + 1 && g.pageH <= g.clientH + 1,
      `after resize the page is ${g.pageW.toFixed(0)}x${g.pageH.toFixed(0)} ` +
      `in ${g.clientW}x${g.clientH}`);
    const fill = Math.max(g.pageW / g.clientW, g.pageH / g.clientH);
    assert(fill > 0.9, `page only fills ${(fill * 100).toFixed(0)}% after resize`);
    return `refitted to ${g.pageW.toFixed(0)}x${g.pageH.toFixed(0)} (${g.label})`;
  });

  await check('Fit Width fills the width', async () => {
    await js(`window.__app.applyFit('fit-width')`);
    await wait(700);
    const g = await geom();
    assert(Math.abs(g.pageW - g.clientW) < 50,
      `page width ${g.pageW.toFixed(0)} vs viewport ${g.clientW}`);
    return `${g.pageW.toFixed(0)}px wide (${g.label})`;
  });

  await check('zoom in and out change the scale and leave fit mode', async () => {
    await js(`window.__app.applyFit('fit')`); await wait(600);
    const before = (await geom()).scale;
    await js(`window.__app.zoom(1)`); await wait(700);
    const inScale = (await geom()).scale;
    await js(`window.__app.zoom(-1)`); await wait(700);
    const g = await geom();
    assert(inScale > before, `zoom in went ${before.toFixed(2)} -> ${inScale.toFixed(2)}`);
    assert(g.scale < inScale, 'zoom out did not reduce the scale');
    assert(g.mode === 'manual', `zoom should switch to manual, got "${g.mode}"`);
    return `${before.toFixed(2)} → ${inScale.toFixed(2)} → ${g.scale.toFixed(2)}`;
  });

  await check('⌘0 returns to a fitted page', async () => {
    await js(`window.__app.zoom(0)`);
    await wait(800);
    const g = await geom();
    assert(g.mode === 'fit', `mode is "${g.mode}"`);
    assert(g.pageW <= g.clientW + 1 && g.pageH <= g.clientH + 1, 'not fitted');
    return g.label;
  });

  await check('scrolling deep into the document renders those pages', async () => {
    const target = await js(`(async () => {
      const A = window.__app;
      const n = A.state.pages.length;
      const idx = Math.min(n - 1, Math.max(1, Math.floor(n * 0.8)));
      A.state.pages[idx].el.scrollIntoView();
      return idx;
    })()`);
    await wait(2500);
    const out = await js(`(() => {
      const A = window.__app, p = A.state.pages[${target}];
      const c = p.canvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 200) ink++;
      return JSON.stringify({ rendered: p.rendered, ink,
        current: A.state.currentPage, status: document.querySelector('#statusText').textContent });
    })()`).then(JSON.parse);
    assert(out.rendered, `page ${target + 1} never rendered`);
    assert(out.ink > 200, `page ${target + 1} rendered blank (${out.ink} ink pixels)`);
    assert(out.current >= target - 1,
      `status still says page ${out.current + 1}, expected ~${target + 1}`);
    return `page ${target + 1} rendered (${out.ink} ink px); status: "${out.status.replace(/<[^>]*>/g, '').trim()}"`;
  });

  await check('zooming keeps your place in the document', async () => {
    const out = await js(`(async () => {
      const A = window.__app;
      const before = A.scrollAnchor();
      await A.reflow(A.state.scale * 1.5, 'manual');
      const after = A.scrollAnchor();
      return JSON.stringify({ before, after });
    })()`).then(JSON.parse);
    assert(out.before && out.after, 'no scroll anchor');
    assert(Math.abs(out.after.index - out.before.index) <= 1,
      `jumped from page ${out.before.index + 1} to ${out.after.index + 1}`);
    return `stayed on page ${out.after.index + 1} across a zoom`;
  });

  await check('highlighting is accurate when zoomed in', async () => {
    const out = await js(`(async () => {
      const A = window.__app;
      await A.applyFit('fit-width');
      await new Promise(r => setTimeout(r, 800));
      await A.reflow(A.state.scale * 1.4, 'manual');
      await new Promise(r => setTimeout(r, 900));

      // find a page with selectable text
      let page = null;
      for (const p of A.state.pages) {
        if (!p.rendered) continue;
        if (p.textLayerDiv.querySelectorAll('span').length > 2) { page = p; break; }
      }
      if (!page) return JSON.stringify({ skip: 'no text layer on any rendered page' });

      const spans = [...page.textLayerDiv.querySelectorAll('span')]
        .filter(s => s.textContent.trim().length > 4);
      if (!spans.length) return JSON.stringify({ skip: 'no substantial text runs' });

      A.setTool('highlight');
      const r = document.createRange();
      r.selectNodeContents(spans[0]);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      A.applyTextMarkup();

      const hl = A.state.annots.filter(a => a.type === 'highlight');
      if (!hl.length) return JSON.stringify({ skip: 'selection produced no highlight' });
      const q = hl[hl.length - 1].quads[0];

      // Compare against the span's own position, converted to PDF points.
      const sr = spans[0].getBoundingClientRect();
      const c0 = A.toPdf(page, sr.left, sr.bottom);
      const c1 = A.toPdf(page, sr.right, sr.top);

      // The correct vertical reference is the font's own ascent/descent about
      // the baseline -- the same thing PDFKit uses -- NOT the browser's line
      // box, which is taller.
      const bx0 = Math.min(c0[0], c1[0]), bx1 = Math.max(c0[0], c1[0]);
      const hits = (page.textItems || []).filter(i =>
        i.baseline > Math.min(q[5], q[1]) - 1 && i.baseline < Math.max(q[5], q[1]) + 1 &&
        i.x1 > bx0 - 1 && i.x0 < bx1 + 1);
      const expect = hits.length ? {
        y0: hits[0].baseline + hits[0].size * (hits[0].descent ?? -0.218),
        y1: hits[0].baseline + hits[0].size * (hits[0].ascent ?? 0.685),
      } : null;

      return JSON.stringify({
        scale: A.state.scale,
        quadX: [q[0], q[2]], spanX: [bx0, bx1],
        quadY: [q[5], q[1]], expect,
        text: spans[0].textContent.slice(0, 30),
      });
    })()`).then(JSON.parse);
    if (out.skip) return `skipped -- ${out.skip}`;
    assert(Math.abs(out.quadX[0] - out.spanX[0]) < 2,
      `left edge off by ${(out.quadX[0] - out.spanX[0]).toFixed(2)}pt at ${out.scale.toFixed(2)}x`);
    assert(Math.abs(out.quadX[1] - out.spanX[1]) < 2,
      `right edge off by ${(out.quadX[1] - out.spanX[1]).toFixed(2)}pt at ${out.scale.toFixed(2)}x`);
    if (out.expect) {
      assert(Math.abs(out.quadY[0] - out.expect.y0) < 0.5 &&
             Math.abs(out.quadY[1] - out.expect.y1) < 0.5,
        `band ${out.quadY.map(v => v.toFixed(2))} but the font metrics say ` +
        `${[out.expect.y0, out.expect.y1].map(v => v.toFixed(2))}`);
    }
    return `at ${out.scale.toFixed(2)}x, within 2pt horizontally and ` +
           `0.5pt of the font's own ascent/descent on "${out.text}…"`;
  });

  await check('paste and save work at a fitted zoom', async () => {
    const out = await js(`(async () => {
      const A = window.__app;
      await A.applyFit('fit');
      await new Promise(r => setTimeout(r, 700));
      const before = A.state.annots.length;
      await A.pasteImage();
      const img = A.state.annots.find(a => a.type === 'image');
      if (!img) return JSON.stringify({ skip: 'no image on the clipboard' });
      await A.save(false);
      return JSON.stringify({ before, after: A.state.annots.length,
        dirty: A.state.dirty, rect: img.rect });
    })()`).then(JSON.parse);
    if (out.skip) return `skipped -- ${out.skip}`;
    assert(out.after > out.before, 'paste added nothing');
    assert(!out.dirty, 'still dirty after save');
    assert(out.rect.w > 10 && out.rect.h > 10,
      `pasted image is ${out.rect.w}x${out.rect.h}pt`);
    return `pasted ${out.rect.w.toFixed(0)}x${out.rect.h.toFixed(0)}pt and saved`;
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => main().catch((e) => {
  console.error('sanity harness crashed:', e);
  app.exit(2);
}));
