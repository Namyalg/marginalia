'use strict';
/**
 * Writes annotations into a PDF as REAL PDF annotation objects (/Annots entries)
 * with self-generated appearance streams (/AP /N).
 *
 * Why both:
 *   - Real annotation dicts  -> Preview/PDFKit treats them as editable markup
 *                               (selectable, movable, deletable), same as its own.
 *   - Explicit /AP streams   -> every other viewer (Chrome, pdf.js, Acrobat)
 *                               renders them too, since many viewers only draw
 *                               annotations that ship an appearance stream.
 */
const {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFArray, PDFDict,
  StandardFonts,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * EB Garamond, pre-subset to Latin-1 plus common typographic punctuation.
 * pdf-lib's own subsetter drops most glyphs from this face, so the font is
 * subset ahead of time with fonttools and embedded whole (42KB).
 */
const TEXT_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'EBGaramond-Text.ttf');

const PDF_DATE = (d) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.abs(off) / 60 | 0)}'${p(Math.abs(off) % 60)}'`;
};

// ---------------------------------------------------------------- primitives

const n = (v) => {
  if (!Number.isFinite(v)) throw new Error(`non-finite number in annotation geometry: ${v}`);
  // PDF reals: avoid exponent notation, which many parsers reject.
  return (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
};
const rgb = (c) => `${n(c[0])} ${n(c[1])} ${n(c[2])}`;

/**
 * WinAnsiEncoding is the appearance-stream font encoding, and its 0x80-0x9F
 * range holds the typographic characters people actually type -- em dashes,
 * curly quotes, ellipses. Those are NOT at their Unicode code points, so they
 * need an explicit map or they get mangled.
 */
const WIN_ANSI_SPECIALS = new Map(Object.entries({
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
  '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
  '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
  '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
  '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
}));

const octal = (byte) => '\\' + byte.toString(8).padStart(3, '0');

/**
 * Escape a string into a PDF literal string, encoded as WinAnsi.
 * Characters WinAnsi genuinely cannot represent become '?'.
 */
function lit(text) {
  let out = '(';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
    else if (code >= 0x20 && code <= 0x7E) out += ch;
    else if (WIN_ANSI_SPECIALS.has(ch)) out += octal(WIN_ANSI_SPECIALS.get(ch));
    else if (code >= 0xA0 && code <= 0xFF) out += octal(code);
    else out += '?';
  }
  return out + ')';
}

/** What the AP font can actually show -- used for width measurement only. */
const winAnsi = (s) => String(s).replace(
  /[^\x20-\x7E\xA0-\xFF]/g,
  (ch) => (WIN_ANSI_SPECIALS.has(ch) ? ch : '?'));

const normRect = (r) => {
  const x0 = Math.min(r.x, r.x + r.w), x1 = Math.max(r.x, r.x + r.w);
  const y0 = Math.min(r.y, r.y + r.h), y1 = Math.max(r.y, r.y + r.h);
  return [x0, y0, x1, y1];
};

/** Bounding box of a set of [x,y] points, padded by `pad`. */
const bboxOfPoints = (pts, pad = 0) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad,
          Math.max(...xs) + pad, Math.max(...ys) + pad];
};

// ---------------------------------------------------------------- appearances

/**
 * Build a Form XObject appearance stream.
 * BBox is given in page user space and Matrix is identity, so the stream's
 * drawing operators use the same absolute coordinates as /Rect. That keeps the
 * geometry math in one space instead of two.
 */
function makeAP(ctx, bbox, content, resources) {
  const dict = {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: ctx.obj(bbox.map((v) => Math.round(v * 1000) / 1000)),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
    Resources: resources || ctx.obj({}),
  };
  return ctx.register(ctx.flateStream(content, dict));
}

/** ExtGState enabling Multiply blend, so highlights darken rather than cover. */
function multiplyGS(ctx, alpha) {
  return ctx.obj({
    ExtGState: ctx.obj({
      GSmul: ctx.obj({ Type: 'ExtGState', BM: 'Multiply', ca: alpha, CA: alpha }),
    }),
  });
}

function quadsToRects(quads) {
  // /QuadPoints order is x1 y1 x2 y2 x3 y3 x4 y4 = UL UR LL LR.
  return quads.map((q) => {
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return { x: Math.min(...xs), y: Math.min(...ys),
             w: Math.max(...xs) - Math.min(...xs),
             h: Math.max(...ys) - Math.min(...ys) };
  });
}

function ellipsePath(x0, y0, x1, y1) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const k = 0.5523;                                  // circle->bezier constant
  const ox = rx * k, oy = ry * k;
  return [
    `${n(cx - rx)} ${n(cy)} m`,
    `${n(cx - rx)} ${n(cy + oy)} ${n(cx - ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
    `${n(cx + ox)} ${n(cy + ry)} ${n(cx + rx)} ${n(cy + oy)} ${n(cx + rx)} ${n(cy)} c`,
    `${n(cx + rx)} ${n(cy - oy)} ${n(cx + ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
    `${n(cx - ox)} ${n(cy - ry)} ${n(cx - rx)} ${n(cy - oy)} ${n(cx - rx)} ${n(cy)} c`,
    'h',
  ].join('\n');
}

/** Wrap `text` to `maxWidth`, honouring explicit newlines. */
function wrapText(text, font, size, maxWidth) {
  const out = [];
  const breakLong = (word) => {
    let piece = '';
    for (const ch of word) {
      if (piece && font.widthOfTextAtSize(piece + ch, size) > maxWidth) {
        out.push(piece);
        piece = ch;
      } else piece += ch;
    }
    return piece;
  };

  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const cand = line + word;
      if (line && font.widthOfTextAtSize(cand, size) > maxWidth) {
        out.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      } else {
        line = cand;
      }
      // A word wider than the box has to be split, or it runs past the edge.
      if (font.widthOfTextAtSize(line, size) > maxWidth) line = breakLong(line);
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

// ---------------------------------------------------------------- annotations

/**
 * One annotation -> one /Annots dict ref. Every branch returns a dict carrying
 * both the semantic fields (so PDFKit can edit it) and an /AP (so everyone can
 * see it).
 */
function buildAnnot(doc, page, a, ctx, helpers) {
  const color = a.color || [1, 0.85, 0.2];
  const opacity = a.opacity == null ? 1 : a.opacity;
  const stroke = a.strokeWidth == null ? 2 : a.strokeWidth;
  const base = {
    Type: 'Annot',
    NM: PDFString.of(a.id),
    M: PDFString.of(PDF_DATE(new Date())),
    F: 4,                                            // Print
    C: ctx.obj(color),
    CA: opacity,
    T: PDFString.of(a.author || 'PDF Annotator'),
  };
  if (a.contents) base.Contents = PDFHexString.fromText(String(a.contents));

  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout': {
      const quads = a.quads || [];
      if (!quads.length) return null;
      const rects = quadsToRects(quads);
      const bbox = bboxOfPoints(
        rects.flatMap((r) => [[r.x, r.y], [r.x + r.w, r.y + r.h]]), 1);
      let content, res;
      if (a.type === 'highlight') {
        content = '/GSmul gs\n' + rgb(color) + ' rg\n' +
          rects.map((r) => `${n(r.x)} ${n(r.y)} ${n(r.w)} ${n(r.h)} re`).join('\n') + '\nf';
        res = multiplyGS(ctx, opacity);
      } else {
        const t = Math.max(0.7, rects[0].h * 0.06);
        content = rgb(color) + ' rg\n' + rects.map((r) => {
          const y = a.type === 'underline' ? r.y + r.h * 0.06 : r.y + r.h * 0.42;
          return `${n(r.x)} ${n(y)} ${n(r.w)} ${n(t)} re`;
        }).join('\n') + '\nf';
        res = ctx.obj({});
      }
      const subtype = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' }[a.type];
      return ctx.obj({
        ...base, Subtype: subtype,
        Rect: ctx.obj(bbox),
        QuadPoints: ctx.obj(quads.flat()),
        AP: ctx.obj({ N: makeAP(ctx, bbox, content, res) }),
      });
    }

    case 'square':
    case 'circle': {
      const [x0, y0, x1, y1] = normRect(a.rect);
      const h = stroke / 2;
      const rect = [x0 - h, y0 - h, x1 + h, y1 + h];
      const filled = !!a.fill;
      let content = `${n(stroke)} w\n${rgb(color)} RG\n`;
      if (filled) content += `${rgb(a.fill)} rg\n`;
      const path = a.type === 'square'
        ? `${n(x0 + h)} ${n(y0 + h)} ${n(x1 - x0 - stroke)} ${n(y1 - y0 - stroke)} re`
        : ellipsePath(x0 + h, y0 + h, x1 - h, y1 - h);
      content += path + '\n' + (filled ? 'B' : 'S');
      const dict = {
        ...base, Subtype: a.type === 'square' ? 'Square' : 'Circle',
        Rect: ctx.obj(rect),
        BS: ctx.obj({ W: stroke, S: 'S' }),
        AP: ctx.obj({ N: makeAP(ctx, rect, content) }),
      };
      if (filled) dict.IC = ctx.obj(a.fill);
      return ctx.obj(dict);
    }

    case 'line':
    case 'arrow': {
      const [p0, p1] = a.points;
      const head = a.type === 'arrow' ? Math.max(6, stroke * 3.5) : 0;
      const bbox = bboxOfPoints([p0, p1], stroke + head + 2);
      let content = `${n(stroke)} w 1 J 1 j\n${rgb(color)} RG\n${rgb(color)} rg\n` +
        `${n(p0[0])} ${n(p0[1])} m ${n(p1[0])} ${n(p1[1])} l S`;
      if (head) {
        const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const wing = 0.42;                            // half-angle of the head
        const a1 = [p1[0] - head * Math.cos(ang - wing), p1[1] - head * Math.sin(ang - wing)];
        const a2 = [p1[0] - head * Math.cos(ang + wing), p1[1] - head * Math.sin(ang + wing)];
        content += `\n${n(p1[0])} ${n(p1[1])} m ${n(a1[0])} ${n(a1[1])} l ` +
                   `${n(a2[0])} ${n(a2[1])} l h f`;
      }
      const dict = {
        ...base, Subtype: 'Line',
        Rect: ctx.obj(bbox),
        L: ctx.obj([p0[0], p0[1], p1[0], p1[1]]),
        BS: ctx.obj({ W: stroke, S: 'S' }),
        AP: ctx.obj({ N: makeAP(ctx, bbox, content) }),
      };
      if (head) dict.LE = ctx.obj(['None', 'ClosedArrow']);
      return ctx.obj(dict);
    }

    case 'ink': {
      const paths = a.paths || [];
      const all = paths.flat();
      if (all.length < 2) return null;
      const bbox = bboxOfPoints(all, stroke + 2);
      const content = `${n(stroke)} w 1 J 1 j\n${rgb(color)} RG\n` +
        paths.map((p) => p.map(([x, y], i) =>
          `${n(x)} ${n(y)} ${i ? 'l' : 'm'}`).join(' ') + ' S').join('\n');
      return ctx.obj({
        ...base, Subtype: 'Ink',
        Rect: ctx.obj(bbox),
        InkList: ctx.obj(paths.map((p) => ctx.obj(p.flat()))),
        BS: ctx.obj({ W: stroke, S: 'S' }),
        AP: ctx.obj({ N: makeAP(ctx, bbox, content) }),
      });
    }

    case 'freetext': {
      const [x0, y0, x1, y1] = normRect(a.rect);
      const size = a.fontSize || 14;
      const pad = 2;
      const font = helpers.font;
      // The renderer measures and wraps with the same Helvetica metrics, so
      // prefer its line breaks: what the user saw is what gets written.
      const lines = Array.isArray(a.lines) && a.lines.length
        ? a.lines
        : wrapText(a.text || '', helpers.font, size, Math.max(4, x1 - x0 - pad * 2));
      const lead = size * 1.2;
      let content = '';
      if (a.background) {
        content += `${rgb(a.background)} rg\n${n(x0)} ${n(y0)} ${n(x1 - x0)} ${n(y1 - y0)} re f\n`;
      }
      // An embedded TrueType face is a CID font: text has to be written as
      // glyph ids, which is exactly what encodeText produces.
      const show = (line) => helpers.fontIsEmbedded
        ? helpers.font.encodeText(line).toString()
        : lit(line);
      content += `BT\n/AnnotFont ${n(size)} Tf\n${n(lead)} TL\n${rgb(color)} rg\n` +
        `1 0 0 1 ${n(x0 + pad)} ${n(y1 - pad - size * 0.85)} Tm\n` +
        lines.map((l, i) => (i ? 'T*\n' : '') + show(l) + ' Tj').join('\n') +
        '\nET';
      const res = ctx.obj({ Font: ctx.obj({ AnnotFont: helpers.fontRef }) });
      const rect = [x0, y0, x1, y1];
      // /DA is what a PDF editor re-parses when the user edits the text.
      const da = `${rgb(color)} rg /AnnotFont ${n(size)} Tf`;
      return ctx.obj({
        ...base, Subtype: 'FreeText',
        Rect: ctx.obj(rect),
        Contents: PDFHexString.fromText(String(a.text || '')),
        DA: PDFString.of(da),
        Q: 0,
        // A visible border is Preview-unlike; keep the box itself invisible.
        BS: ctx.obj({ W: 0, S: 'S' }),
        AP: ctx.obj({ N: makeAP(ctx, rect, content, res) }),
      });
    }

    case 'note': {
      // Preview's "Note": a collapsed sticky note with a popup body.
      // Sized by the caller, because a 20pt icon is a speck on a 1920pt slide.
      const s = a.size || 20;
      const x = a.rect.x, y = a.rect.y;
      const rect = [x, y - s, x + s, y];
      const content =
        `${rgb(color)} rg\n0.25 0.2 0.1 RG\n0.8 w\n` +
        `${n(x + 1)} ${n(y - s + 1)} ${n(s - 2)} ${n(s - 2)} re B\n` +
        `0.25 0.2 0.1 RG\n0.7 w\n` +
        [0.68, 0.5, 0.32].map((f) =>
          `${n(x + 4)} ${n(y - s + s * f)} m ${n(x + s - 4)} ${n(y - s + s * f)} l S`).join('\n');
      return ctx.obj({
        ...base, Subtype: 'Text',
        Rect: ctx.obj(rect),
        Name: 'Comment',
        Open: false,
        Contents: PDFHexString.fromText(String(a.text || '')),
        AP: ctx.obj({ N: makeAP(ctx, rect, content) }),
      });
    }

    case 'image': {
      const img = helpers.images.get(a.imageId);
      if (!img) throw new Error(`image ${a.imageId} was not embedded`);
      const [x0, y0, x1, y1] = normRect(a.rect);
      const w = x1 - x0, h = y1 - y0;
      const cx = x0 + w / 2, cy = y0 + h / 2;

      // a.rotation is degrees CLOCKWISE as the user sees it on screen. PDF user
      // space is y-up, so the same visual turn is a negative angle here.
      // (Verified against a CoreGraphics render of an asymmetric fixture --
      // see the rotation tests in test/roundtrip.js.)
      const theta = -(a.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(theta), sin = Math.sin(theta);

      // Map the unit square onto the rotated rectangle about its centre:
      //   x' = u·w·cos - v·h·sin + e
      //   y' = u·w·sin + v·h·cos + f
      const m = [
        w * cos, w * sin,
        -h * sin, h * cos,
        cx - (w * cos - h * sin) / 2,
        cy - (w * sin + h * cos) / 2,
      ];

      // /Rect must contain the painted result, so use the rotated AABB.
      const hx = (Math.abs(w * cos) + Math.abs(h * sin)) / 2;
      const hy = (Math.abs(w * sin) + Math.abs(h * cos)) / 2;
      const rect = [cx - hx, cy - hy, cx + hx, cy + hy];

      const content = `q\n${m.map(n).join(' ')} cm\n/ImAP Do\nQ`;
      const res = ctx.obj({
        XObject: ctx.obj({ ImAP: img.ref }),
        ProcSet: ctx.obj(['PDF', 'ImageC']),
      });
      return ctx.obj({
        ...base, Subtype: 'Stamp',
        Rect: ctx.obj(rect),
        Name: 'Draft',
        Contents: PDFHexString.fromText(a.contents || 'Pasted image'),
        AP: ctx.obj({ N: makeAP(ctx, rect, content, res) }),
      });
    }

    default:
      throw new Error(`unknown annotation type: ${a.type}`);
  }
}

// ---------------------------------------------------------------- entry point

/**
 * @param {Uint8Array} bytes            original PDF
 * @param {Array}      annotations      see renderer/annots.js for the shape
 * @param {Object}     images           { [imageId]: base64 PNG (no data: prefix) }
 * @returns {Promise<Uint8Array>}
 */
/**
 * Pull the image out of a /Stamp annotation's appearance stream, so a pasted
 * image can be re-imported and moved when the file is opened again.
 * Returns a base64 data payload, or null if the image is in a form we cannot
 * rebuild (in which case the caller keeps the annotation read-only).
 */
function extractStampImage(doc, annotDict) {
  try {
    const ap = annotDict.lookup(PDFName.of('AP'));
    if (!ap) return null;
    const form = ap.lookup(PDFName.of('N'));
    if (!form) return null;
    const res = form.dict.lookup(PDFName.of('Resources'));
    const xo = res && res.lookup(PDFName.of('XObject'));
    if (!xo) return null;

    for (const [, ref] of xo.entries()) {
      const img = doc.context.lookup(ref);
      if (!img || !img.dict) continue;
      const d = img.dict;
      if (String(d.lookup(PDFName.of('Subtype'))) !== '/Image') continue;

      const width = d.lookup(PDFName.of('Width')).asNumber();
      const height = d.lookup(PDFName.of('Height')).asNumber();
      const filter = d.lookup(PDFName.of('Filter'));
      const filterName = filter ? String(filter) : '';
      const bpc = d.lookup(PDFName.of('BitsPerComponent'));
      const cs = d.lookup(PDFName.of('ColorSpace'));

      // A JPEG is already a file: hand it back untouched.
      if (filterName.includes('DCTDecode')) {
        return { kind: 'jpeg', width, height,
                 data: Buffer.from(img.contents).toString('base64') };
      }

      // Flate-compressed samples: re-wrap them as a PNG.
      if (filterName.includes('FlateDecode') &&
          bpc && bpc.asNumber() === 8) {
        const csName = cs ? String(cs) : '';
        const channels = csName.includes('DeviceRGB') ? 3
          : csName.includes('DeviceGray') ? 1 : 0;
        if (!channels) return null;
        const raw = zlib.inflateSync(Buffer.from(img.contents));
        if (raw.length < width * height * channels) return null;
        return { kind: 'png', width, height,
                 data: rawToPng(raw, width, height, channels).toString('base64') };
      }
    }
  } catch (e) {
    return { error: e.message };
  }
  return { error: 'no rebuildable image in the appearance stream' };
}

/** Wrap raw 8-bit samples as a PNG. */
function rawToPng(raw, width, height, channels) {
  const stride = width * channels;
  const body = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    body[y * (1 + stride)] = 0;                       // filter: none
    raw.copy(body, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const table = [...Array(256)].map((_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xFFFFFFFF;
    for (const v of b) c = table[(c ^ v) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(body)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Small readers for the annotation dictionary entries we care about. */
const numsOf = (arr) => {
  if (!arr || !arr.asArray) return null;
  return arr.asArray().map((v) => (v && v.asNumber ? v.asNumber() : Number(v)));
};
const textOf = (v) => {
  if (!v) return '';
  if (typeof v.decodeText === 'function') return v.decodeText();
  if (typeof v.asString === 'function') return v.asString();
  return String(v.value != null ? v.value : v);
};

/**
 * Everything already in the file that this app can take over and edit.
 *
 * Identified by page and position in that page's /Annots array, NOT by /NM:
 * plenty of PDFs (including files other editors have rewritten) carry no
 * annotation names at all, and keying on them made whole documents read-only.
 * Saving re-derives from the original bytes, so these positions stay valid.
 */
async function readExistingAnnotations(bytes) {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true, updateMetadata: false,
  });
  const out = [];

  for (const [pageIndex, page] of doc.getPages().entries()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;

    for (let index = 0; index < annots.size(); index++) {
      const dict = annots.lookup(index);
      if (!dict || !dict.lookup) continue;
      const subtype = String(dict.lookup(PDFName.of('Subtype')) || '').replace(/^\//, '');
      const entry = { page: pageIndex, index, subtype };

      const rect = numsOf(dict.lookup(PDFName.of('Rect')));
      if (rect && rect.length === 4) entry.rect = rect;
      const c = numsOf(dict.lookup(PDFName.of('C')));
      if (c && c.length >= 3) entry.color = c.slice(0, 3);
      const ic = numsOf(dict.lookup(PDFName.of('IC')));
      if (ic && ic.length >= 3) entry.fill = ic.slice(0, 3);
      entry.contents = textOf(dict.lookup(PDFName.of('Contents')));

      const bs = dict.lookup(PDFName.of('BS'));
      const w = bs && bs.lookup && bs.lookup(PDFName.of('W'));
      if (w && w.asNumber) entry.strokeWidth = w.asNumber();

      const da = dict.lookup(PDFName.of('DA'));
      if (da) entry.da = textOf(da);

      if (subtype === 'Highlight' || subtype === 'Underline' || subtype === 'StrikeOut') {
        const q = numsOf(dict.lookup(PDFName.of('QuadPoints')));
        if (q && q.length >= 8) entry.quadPoints = q;
      }
      if (subtype === 'Line') {
        const l = numsOf(dict.lookup(PDFName.of('L')));
        if (l && l.length === 4) entry.line = l;
        const le = dict.lookup(PDFName.of('LE'));
        entry.arrow = le ? String(le).includes('Arrow') : false;
      }
      if (subtype === 'Ink') {
        const ink = dict.lookup(PDFName.of('InkList'));
        if (ink && ink.asArray) {
          entry.inkList = ink.asArray()
            .map((sub) => numsOf(doc.context.lookup(sub) || sub))
            .filter(Boolean);
        }
      }
      if (subtype === 'Stamp') {
        const img = extractStampImage(doc, dict);
        if (img && img.data) entry.image = img;
        else entry.imageError = (img && img.error) || 'unknown';
      }
      out.push(entry);
    }
  }
  return out;
}

async function writeAnnotations(bytes, annotations, images = {}, removeAt = []) {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const ctx = doc.context;
  const pages = doc.getPages();

  // The text font is embedded so the PDF looks the same everywhere; if the file
  // is missing for any reason, fall back to a standard face rather than fail.
  let font, fontIsEmbedded = false;
  try {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(fs.readFileSync(TEXT_FONT_PATH), { subset: false });
    fontIsEmbedded = true;
  } catch (e) {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }

  // Only embed images that are actually referenced, once each.
  const used = new Set(annotations.filter((a) => a.type === 'image').map((a) => a.imageId));
  const embedded = new Map();
  for (const id of used) {
    const b64 = images[id];
    if (!b64) throw new Error(`missing image data for ${id}`);
    embedded.set(id, await doc.embedPng(Buffer.from(b64, 'base64')));
  }

  const helpers = { font, fontRef: font.ref, fontIsEmbedded, images: embedded };
  let written = 0;

  // Anything being re-written from the editor must have its original removed
  // first, or the file would end up with both copies. Positions refer to the
  // original bytes, which is exactly what we loaded, and are removed from the
  // back so earlier indices stay valid.
  const byPage = new Map();
  for (const { page, index } of removeAt || []) {
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(index);
  }
  for (const [pageIndex, indexes] of byPage) {
    const page = pages[pageIndex];
    if (!page) continue;
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (const i of indexes.slice().sort((a, b) => b - a)) {
      if (i >= 0 && i < annots.size()) annots.remove(i);
    }
  }

  for (const [pageIndex, page] of pages.entries()) {
    const mine = annotations.filter((a) => a.page === pageIndex);
    if (!mine.length) continue;

    const refs = [];
    for (const a of mine) {
      const dict = buildAnnot(doc, page, a, ctx, helpers);
      if (!dict) continue;
      dict.set(PDFName.of('P'), page.ref);
      refs.push(ctx.register(dict));
      written++;
    }
    if (!refs.length) continue;

    // Append to any /Annots the document already had, rather than replacing.
    const existing = page.node.lookup(PDFName.of('Annots'));
    if (existing instanceof PDFArray) {
      refs.forEach((r) => existing.push(r));
    } else {
      page.node.set(PDFName.of('Annots'), ctx.obj(refs));
    }
  }

  // Marks the file as containing annotations that need appearance regeneration
  // only if a viewer disagrees with ours; ours are already correct.
  const bytesOut = await doc.save({ useObjectStreams: false });
  return { bytes: bytesOut, written };
}

module.exports = {
  writeAnnotations, readExistingAnnotations, PDF_DATE, wrapText, winAnsi,
};
