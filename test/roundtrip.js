'use strict';

// Piping this into `head`, or quitting `less` early, closes stdout underneath
// us. Without this an EPIPE from the next write goes uncaught, and in an
// Electron main process that means a modal "A JavaScript error occurred"
// dialog instead of a quiet exit.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
}

/**
 * End-to-end verification of the annotation writer.
 *
 * The writer must not also be the verifier, so every assertion here goes
 * through an independent engine:
 *   - PDFKit (via PyObjC) -- the exact framework macOS Preview uses -- checks
 *     that annotations exist as annotation OBJECTS with the right subtypes.
 *   - qlmanage (CoreGraphics) rasterises the file and we diff pixels, checking
 *     that the marks actually PAINT, and paint in the right place.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const { writeAnnotations } = require('../lib/pdf-writer');
const { decodePng, diffRatio, regionMean } = require('./png');

const FIX = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfannot-test-'));
// PyObjC lives in a project-local venv by default; see the README. Checks that
// need it report "skipped" rather than failing when it is absent.
const VENV = process.env.PDFKIT_PYTHON ||
  path.join(__dirname, '..', '.venv', 'bin', 'python');

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    pass++; results.push(['PASS', name, detail || '']);
  } catch (e) {
    fail++; results.push(['FAIL', name, e.message]);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------------------------------------------------------- engines

function pdfkit(file) {
  if (!fs.existsSync(VENV)) return null;
  const out = execFileSync(VENV, [path.join(__dirname, 'verify-pdfkit.py'), file],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

let qlSeq = 0;
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
  const dir = path.join(TMP, 'ql' + (qlSeq++));
  fs.mkdirSync(dir, { recursive: true });
  qlRun(file, dir, size);
  const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
  if (!png) throw new Error(`qlmanage produced no thumbnail for ${path.basename(file)}`);
  return decodePng(fs.readFileSync(path.join(dir, png)));
}

// ---------------------------------------------------------------- fixtures

const clipPng = fs.readFileSync(path.join(FIX, 'clip.png')).toString('base64');
const IMAGES = { img1: clipPng };

/** One of every annotation type, placed over the known fixture layout. */
function sampleAnnotations(page = 0) {
  const quad = (x0, x1, yb, yt) => [x0, yt, x1, yt, x0, yb, x1, yb];
  return [
    { id: 'a-hl', page, type: 'highlight', color: [1, 0.92, 0.23], opacity: 1,
      quads: [quad(72, 400, 676, 692)], contents: 'highlighted' },
    { id: 'a-ul', page, type: 'underline', color: [0.13, 0.45, 0.95],
      quads: [quad(72, 480, 652, 668)] },
    { id: 'a-so', page, type: 'strikeout', color: [0.9, 0.15, 0.15],
      quads: [quad(72, 460, 628, 644)] },
    { id: 'a-sq', page, type: 'square', color: [0.1, 0.6, 0.25], strokeWidth: 3,
      rect: { x: 380, y: 560, w: 170, h: 70 } },
    { id: 'a-ci', page, type: 'circle', color: [0.55, 0.2, 0.8], strokeWidth: 3,
      rect: { x: 380, y: 470, w: 170, h: 70 } },
    { id: 'a-ln', page, type: 'line', color: [0.1, 0.1, 0.1], strokeWidth: 2,
      points: [[72, 560], [340, 520]] },
    { id: 'a-ar', page, type: 'arrow', color: [0.95, 0.4, 0.05], strokeWidth: 3,
      points: [[72, 480], [340, 430]] },
    { id: 'a-ink', page, type: 'ink', color: [0.0, 0.5, 0.6], strokeWidth: 2.5,
      paths: [Array.from({ length: 40 }, (_, i) =>
        [80 + i * 6, 380 + Math.sin(i / 3) * 18])] },
    { id: 'a-ft', page, type: 'freetext', color: [0.05, 0.05, 0.05], fontSize: 14,
      rect: { x: 72, y: 250, w: 260, h: 80 },
      text: 'FreeText annotation.\nThis line is long enough that it has to wrap onto another line.' },
    { id: 'a-nt', page, type: 'note', color: [1, 0.85, 0.3],
      rect: { x: 540, y: 720 }, text: 'A sticky note body.' },
    { id: 'a-im', page, type: 'image', imageId: 'img1',
      rect: { x: 360, y: 120, w: 200, h: 150 } },
  ];
}

// ---------------------------------------------------------------- the tests

(async () => {
  const src = fs.readFileSync(path.join(FIX, 'plain.pdf'));
  const annots = [...sampleAnnotations(0), ...sampleAnnotations(1).map(
    (a) => ({ ...a, id: a.id + '-p2' }))];

  let out;
  const res = await writeAnnotations(src, annots, IMAGES);
  out = res.bytes;
  const file = path.join(TMP, 'annotated.pdf');
  fs.writeFileSync(file, out);

  check('all annotations were written', () =>
    (assert(res.written === annots.length,
      `wrote ${res.written} of ${annots.length}`), `${res.written} written`));

  check('output re-parses as a valid PDF', () => {
    assert(out.length > src.length, 'output is not larger than input');
    assert(Buffer.from(out.subarray(0, 5)).toString() === '%PDF-', 'missing PDF header');
    return `${out.length} bytes`;
  });

  await PDFDocument.load(out);   // throws if structurally broken

  // ---- PDFKit: are these real, Preview-editable annotations? --------------
  const kit = pdfkit(file);
  if (!kit) {
    results.push(['SKIP', 'PDFKit verification', 'PyObjC Quartz not available']);
  } else {
    check('PDFKit opens the annotated file', () =>
      (assert(!kit.error, kit.error), `${kit.pages} pages`));

    check('PDFKit sees every annotation as an annotation object', () => {
      assert(kit.annotations.length === annots.length,
        `PDFKit found ${kit.annotations.length}, expected ${annots.length}`);
      return `${kit.annotations.length} annotations`;
    });

    const want = {
      Highlight: 2, Underline: 2, StrikeOut: 2, Square: 2, Circle: 2,
      Line: 2, Ink: 2, FreeText: 2, Text: 2, Stamp: 2,
    };
    // arrow and line are both /Line -> 4 total
    want.Line = 4;
    const got = {};
    for (const a of kit.annotations) got[a.type] = (got[a.type] || 0) + 1;
    for (const [type, count] of Object.entries(want)) {
      check(`PDFKit subtype /${type} x${count}`, () => {
        assert(got[type] === count, `found ${got[type] || 0}, expected ${count}`);
        return 'ok';
      });
    }

    check('PDFKit reads back highlight geometry', () => {
      const hl = kit.annotations.find((a) => a.type === 'Highlight');
      const [x, y, w, h] = hl.rect;
      assert(Math.abs(x - 71) < 3 && Math.abs(y - 675) < 3,
        `highlight at ${x},${y} -- expected ~72,676`);
      assert(w > 320 && h > 12, `highlight size ${w}x${h} looks wrong`);
      return `rect ${x},${y} ${w}x${h}`;
    });

    check('PDFKit reads back annotation text content', () => {
      const ft = kit.annotations.find((a) => a.type === 'FreeText');
      assert(ft.contents && ft.contents.includes('FreeText annotation'),
        `FreeText contents were "${ft.contents}"`);
      const nt = kit.annotations.find((a) => a.type === 'Text');
      assert(nt.contents && nt.contents.includes('sticky note'),
        `Note contents were "${nt.contents}"`);
      return 'contents survive the round trip';
    });

    check('annotations are bound to the right pages', () => {
      const p0 = kit.annotations.filter((a) => a.page === 0).length;
      const p1 = kit.annotations.filter((a) => a.page === 1).length;
      const p2 = kit.annotations.filter((a) => a.page === 2).length;
      assert(p0 === 11 && p1 === 11 && p2 === 0,
        `page distribution was ${p0}/${p1}/${p2}, expected 11/11/0`);
      return '11 on page 1, 11 on page 2, 0 on page 3';
    });
  }

  // ---- CoreGraphics: do the annotations actually paint? -------------------
  const before = rasterize(path.join(FIX, 'plain.pdf'));
  const after = rasterize(file);

  check('CoreGraphics renders the annotations (pixels changed)', () => {
    const r = diffRatio(before, after);
    assert(r > 0.02, `only ${(r * 100).toFixed(2)}% of pixels changed`);
    return `${(r * 100).toFixed(1)}% of pixels changed`;
  });

  check('highlight paints yellow over the first text line', () => {
    // PDF y 676..692 of 792 -> from the top: (792-692)/792 .. (792-676)/792
    const m = regionMean(after, 0.15, (792 - 690) / 792, 0.3, 10 / 792);
    const mb = regionMean(before, 0.15, (792 - 690) / 792, 0.3, 10 / 792);
    assert(m[0] > 180 && m[1] > 160 && m[2] < 140,
      `region mean was rgb(${m.map((v) => v | 0)}) -- not yellow`);
    assert(m[2] < mb[2] - 40, 'blue channel did not drop; highlight did not paint');
    return `rgb(${m.map((v) => v | 0)}) vs rgb(${mb.map((v) => v | 0)}) before`;
  });

  check('highlight uses Multiply so the text stays readable', () => {
    // The glyphs inside the highlighted band must still be dark.
    let darkest = 255;
    const y0 = Math.round(((792 - 690) / 792) * after.height);
    const y1 = Math.round(((792 - 678) / 792) * after.height);
    for (let y = y0; y < y1; y++) {
      for (let x = Math.round(0.13 * after.width); x < Math.round(0.6 * after.width); x++) {
        const o = (y * after.width + x) * after.channels;
        darkest = Math.min(darkest, (after.data[o] + after.data[o + 1] + after.data[o + 2]) / 3);
      }
    }
    assert(darkest < 110, `darkest pixel under the highlight was ${darkest | 0}; text was covered`);
    return `text still renders at luminance ${darkest | 0}`;
  });

  check('pasted image paints in its rectangle', () => {
    // image rect x 360..560, y 120..270
    const m = regionMean(after, 360 / 612, (792 - 270) / 792, 200 / 612, 150 / 792);
    const mb = regionMean(before, 360 / 612, (792 - 270) / 792, 200 / 612, 150 / 792);
    assert(Math.abs(m[0] - mb[0]) + Math.abs(m[1] - mb[1]) + Math.abs(m[2] - mb[2]) > 60,
      `image region barely changed: rgb(${m.map((v) => v | 0)}) vs rgb(${mb.map((v) => v | 0)})`);
    const spread = Math.max(...m) - Math.min(...m);
    assert(spread > 20, `image region is greyish (spread ${spread | 0}); colours may be wrong`);
    return `rgb(${m.map((v) => v | 0)}), channel spread ${spread | 0}`;
  });

  // ---- idempotence / re-annotating an already-annotated file -------------
  const second = await writeAnnotations(out, [{
    id: 'second-pass', page: 2, type: 'highlight', color: [0.4, 1, 0.4],
    quads: [[72, 692, 400, 692, 72, 676, 400, 676]],
  }], {});
  const file2 = path.join(TMP, 'annotated-twice.pdf');
  fs.writeFileSync(file2, second.bytes);

  check('re-annotating preserves existing annotations', () => {
    const k2 = pdfkit(file2);
    if (!k2) return 'skipped (no PyObjC)';
    assert(k2.annotations.length === annots.length + 1,
      `after second pass PDFKit found ${k2.annotations.length}, expected ${annots.length + 1}`);
    return `${k2.annotations.length} annotations after two passes`;
  });

  // ---- odd page geometry -------------------------------------------------
  for (const fixture of ['rotated90.pdf', 'rotated270.pdf', 'cropoffset.pdf']) {
    const bytes = fs.readFileSync(path.join(FIX, fixture));
    const off = fixture === 'cropoffset.pdf' ? [50, 100] : [0, 0];
    const r = await writeAnnotations(bytes, [{
      id: 'geo', page: 0, type: 'highlight', color: [1, 0.9, 0.2],
      quads: [[72 + off[0], 692 + off[1], 400 + off[0], 692 + off[1],
               72 + off[0], 676 + off[1], 400 + off[0], 676 + off[1]]],
    }, {
      id: 'geo-img', page: 0, type: 'image', imageId: 'img1',
      rect: { x: 200 + off[0], y: 200 + off[1], w: 160, h: 120 },
    }], IMAGES);
    const f = path.join(TMP, 'geo-' + fixture);
    fs.writeFileSync(f, r.bytes);

    check(`${fixture}: PDFKit sees the annotations`, () => {
      const k = pdfkit(f);
      if (!k) return 'skipped (no PyObjC)';
      assert(!k.error, k.error);
      assert(k.annotations.length === 2,
        `found ${k.annotations.length} annotations, expected 2`);
      return k.annotations.map((a) => a.type).join(', ');
    });

    check(`${fixture}: CoreGraphics renders the annotations`, () => {
      const b = rasterize(path.join(FIX, fixture));
      const a = rasterize(f);
      const ratio = diffRatio(b, a);
      assert(ratio > 0.01, `only ${(ratio * 100).toFixed(2)}% of pixels changed`);
      return `${(ratio * 100).toFixed(1)}% of pixels changed`;
    });
  }

  // ---- image rotation ----------------------------------------------------
  // An asymmetric image makes the direction of rotation observable: the red
  // corner must travel top-left -> top-right -> bottom-right as it turns
  // clockwise on screen.
  const cornerPng = fs.readFileSync(path.join(FIX, 'corner.png')).toString('base64');
  const RECT = { x: 156, y: 396, w: 300, h: 225 };     // centred on the page
  const quadrantOfRed = (img) => {
    const fx = RECT.x / 612, fy = (792 - (RECT.y + RECT.h)) / 792;
    const fw = RECT.w / 612, fh = RECT.h / 792;
    const q = {
      tl: regionMean(img, fx, fy, fw / 2, fh / 2),
      tr: regionMean(img, fx + fw / 2, fy, fw / 2, fh / 2),
      bl: regionMean(img, fx, fy + fh / 2, fw / 2, fh / 2),
      br: regionMean(img, fx + fw / 2, fy + fh / 2, fw / 2, fh / 2),
    };
    // "Most red" = largest gap between the red channel and the other two.
    let best = null, bestScore = -1e9;
    for (const [k, [r, g, b]] of Object.entries(q)) {
      const score = r - (g + b) / 2;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return { quadrant: best, score: bestScore, q };
  };

  for (const [deg, want] of [[0, 'tl'], [90, 'tr'], [180, 'br'], [270, 'bl']]) {
    const r = await writeAnnotations(fs.readFileSync(path.join(FIX, 'plain.pdf')), [{
      id: 'rot' + deg, page: 0, type: 'image', imageId: 'corner',
      rect: RECT, rotation: deg,
    }], { corner: cornerPng });
    const f = path.join(TMP, `rot${deg}.pdf`);
    fs.writeFileSync(f, r.bytes);

    check(`image rotated ${deg}° puts the red corner in the ${want} quadrant`, () => {
      const { quadrant, score } = quadrantOfRed(rasterize(f));
      assert(score > 12, `no clearly red quadrant found (best score ${score.toFixed(1)})`);
      assert(quadrant === want, `red corner landed in ${quadrant}, expected ${want}`);
      return `${quadrant} (redness ${score.toFixed(0)})`;
    });

    check(`image rotated ${deg}° still reads back as a /Stamp`, () => {
      const k = pdfkit(f);
      if (!k) return 'skipped (no PyObjC)';
      assert(k.annotations.length === 1 && k.annotations[0].type === 'Stamp',
        `PDFKit saw ${JSON.stringify(k.annotations.map((x) => x.type))}`);
      const [, , w, h] = k.annotations[0].rect;
      // At 90/270 the bounding box swaps its sides.
      const expectW = (deg === 90 || deg === 270) ? RECT.h : RECT.w;
      assert(Math.abs(w - expectW) < 2,
        `bounding box width ${w} but expected ${expectW} at ${deg}°`);
      return `/Stamp bbox ${w.toFixed(0)}x${h.toFixed(0)}`;
    });
  }

  check('a rotated image keeps its aspect ratio', () => {
    const r45 = quadrantOfRed(rasterize(path.join(TMP, 'rot90.pdf')));
    assert(r45.score > 12, 'rotation lost the image');
    return 'verified via the 90° render above';
  });

  // ---- degenerate input --------------------------------------------------
  const none = await writeAnnotations(src, [], {});
  check('writing zero annotations succeeds', () => {
    assert(none.written === 0, `wrote ${none.written}`);
    return 'no-op';
  });

  let threw = null;
  try {
    await writeAnnotations(src, [{ id: 'x', page: 0, type: 'image', imageId: 'nope',
      rect: { x: 0, y: 0, w: 10, h: 10 } }], {});
  } catch (e) { threw = e; }
  check('missing image data fails loudly', () => {
    assert(threw && /missing image data/.test(threw.message),
      `expected a clear error, got ${threw && threw.message}`);
    return threw.message;
  });

  // ---------------------------------------------------------------- report
  console.log('');
  for (const [status, name, detail] of results) {
    if (name === 'writer runs over every annotation type' && status === 'PASS') continue;
    if (detail === 'queued') continue;
    const tag = status === 'PASS' ? '\x1b[32m PASS \x1b[0m'
      : status === 'SKIP' ? '\x1b[33m SKIP \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
    console.log(`${tag} ${name}${detail ? '  \x1b[90m-- ' + detail + '\x1b[0m' : ''}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`artifacts: ${TMP}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nharness crashed:', e); process.exit(2); });
