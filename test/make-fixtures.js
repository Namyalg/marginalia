'use strict';
const fs = require('fs'), path = require('path');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');

const OUT = path.join(__dirname, 'fixtures');

const LINES = [
  'The quick brown fox jumps over the lazy dog.',
  'Portable Document Format annotations live in a per-page /Annots array.',
  'Each annotation carries a subtype, a rectangle, and an appearance stream.',
  'Highlight, Underline and StrikeOut are text markup annotations.',
  'Square, Circle, Line and Ink are geometric annotations.',
  'FreeText draws its own text; Stamp can wrap an arbitrary image.',
];

async function base(opts = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < (opts.pages || 2); p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${p + 1}`, { x: 72, y: 720, size: 20, font, color: rgb(0, 0, 0) });
    LINES.forEach((l, i) => page.drawText(l, {
      x: 72, y: 680 - i * 24, size: 12, font, color: rgb(0.1, 0.1, 0.1),
    }));
    if (opts.rotate) page.setRotation({ type: 'degrees', angle: opts.rotate });
    if (opts.cropOffset) {
      const [ox, oy] = opts.cropOffset;
      page.node.set(PDFName.of('MediaBox'), doc.context.obj([ox, oy, ox + 612, oy + 792]));
      page.node.set(PDFName.of('CropBox'), doc.context.obj([ox, oy, ox + 612, oy + 792]));
    }
  }
  return doc.save();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'plain.pdf'), await base({ pages: 3 }));
  fs.writeFileSync(path.join(OUT, 'rotated90.pdf'), await base({ rotate: 90 }));
  fs.writeFileSync(path.join(OUT, 'rotated270.pdf'), await base({ rotate: 270 }));
  fs.writeFileSync(path.join(OUT, 'cropoffset.pdf'), await base({ cropOffset: [50, 100] }));

  // A small PNG with an obvious colour, used as the clipboard-image fixture.
  const { createCanvas } = (() => { try { return require('canvas'); } catch { return {}; } })();
  if (!createCanvas) {
    // Hand-rolled 4x4 magenta PNG so the test suite has zero extra deps.
    const zlib = require('zlib');
    const W = 64, H = 48;
    const raw = Buffer.alloc(H * (1 + W * 3));
    for (let y = 0; y < H; y++) {
      raw[y * (1 + W * 3)] = 0;
      for (let x = 0; x < W; x++) {
        const o = y * (1 + W * 3) + 1 + x * 3;
        const checker = ((x >> 3) + (y >> 3)) % 2;
        raw[o] = checker ? 255 : 20; raw[o + 1] = checker ? 0 : 200; raw[o + 2] = checker ? 200 : 60;
      }
    }
    const crcTable = [...Array(256)].map((_, i) => {
      let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
    });
    const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
    fs.writeFileSync(path.join(OUT, 'clip.png'), png);

    // An deliberately ASYMMETRIC image: white, with a red block in its
    // top-left corner only. Rotation is undetectable in a symmetric image, so
    // this is what proves the turn went the direction the user asked for.
    const AW = 64, AH = 48;
    const araw = Buffer.alloc(AH * (1 + AW * 3), 255);
    for (let y = 0; y < AH; y++) {
      araw[y * (1 + AW * 3)] = 0;
      for (let x = 0; x < AW; x++) {
        const o = y * (1 + AW * 3) + 1 + x * 3;
        const inCorner = x < AW / 3 && y < AH / 3;
        araw[o] = inCorner ? 230 : 255;
        araw[o + 1] = inCorner ? 20 : 255;
        araw[o + 2] = inCorner ? 20 : 255;
      }
    }
    const aihdr = Buffer.alloc(13);
    aihdr.writeUInt32BE(AW, 0); aihdr.writeUInt32BE(AH, 4);
    aihdr[8] = 8; aihdr[9] = 2;
    fs.writeFileSync(path.join(OUT, 'corner.png'), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', aihdr), chunk('IDAT', zlib.deflateSync(araw)), chunk('IEND', Buffer.alloc(0)),
    ]));
  }
  // An encrypted fixture needs a real PDF encryptor; PDFKit is the one we have.
  // Owner password only, so viewers still open it without prompting -- that is
  // exactly the case where a careless save would damage the original.
  const venv = process.env.PDFKIT_PYTHON ||
    path.join(__dirname, '..', '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync(venv, [path.join(__dirname, 'make-encrypted.py'),
        path.join(OUT, 'plain.pdf'), path.join(OUT, 'encrypted.pdf')],
        { stdio: 'ignore' });
    } catch {
      console.warn('could not build encrypted.pdf; that test will be skipped');
    }
  }

  console.log('fixtures written to', OUT);
})();
