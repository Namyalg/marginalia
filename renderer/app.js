import * as pdfjsLib from './vendor/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;

// ---------------------------------------------------------------- constants

const TOOLS = [
  { id: 'select',    label: 'Select',        key: 'V', icon: 'cursor' },
  { id: 'square',    label: 'Rectangle',     key: 'R', icon: 'square' },
  { id: 'circle',    label: 'Ellipse',       key: 'O', icon: 'circle' },
  { id: 'arrow',     label: 'Arrow',         key: 'A', icon: 'arrow' },
  { id: 'line',      label: 'Line',          key: 'L', icon: 'line' },
  { id: 'ink',       label: 'Draw',          key: 'D', icon: 'ink' },
  { id: 'freetext',  label: 'Text',          key: 'T', icon: 'text' },
  { divider: true },
  { id: 'highlight', label: 'Highlight',     key: 'H', icon: 'highlight' },
  { id: 'underline', label: 'Underline',     key: 'U', icon: 'underline' },
  { id: 'strikeout', label: 'Strikethrough', icon: 'strike' },
];

const ICONS = {
  cursor:    '<path d="M4 2l10 7-4.2.9 2.4 4.6-1.9 1-2.4-4.6L4.8 14z"/>',
  highlight: '<path d="M3.5 14.5h11"/><path d="M6 11l4.6-7.2 3 2L9 13z"/><path d="M6 11l3 2"/>',
  underline: '<path d="M5 3v5a3.5 3.5 0 007 0V3"/><path d="M3.5 14.5h11"/>',
  strike:    '<path d="M5 3v5a3.5 3.5 0 007 0V3"/><path d="M2.5 8.5h12"/>',
  ink:       '<path d="M2.5 13c3-1 3.5-9 6-9s2 8 5 7"/>',
  square:    '<rect x="2.5" y="3.5" width="12" height="10" rx="2"/>',
  circle:    '<ellipse cx="8.5" cy="8.5" rx="6" ry="5"/>',
  line:      '<path d="M3 14L14 3"/>',
  arrow:     '<path d="M3 14L14 3"/><path d="M9.2 3H14v4.8"/>',
  text:      '<path d="M3 5V3.5h11V5"/><path d="M8.5 3.5v11"/><path d="M6 14.5h5"/>',
};

/** Excalidraw's own top-pick stroke colours, from
 *  packages/common/src/colors.ts (MIT, Copyright (c) 2020 Excalidraw).
 *  Excalidraw takes these values from Open Color, by heeyeun (MIT, 2016).
 *  See the Credits section of the README. */
const PALETTE = [
  { name: 'Black',  rgb: [0.118, 0.118, 0.118] },   // #1e1e1e
  { name: 'Red',    rgb: [0.980, 0.322, 0.322] },   // #fa5252
  { name: 'Green',  rgb: [0.251, 0.753, 0.341] },   // #40c057
  { name: 'Blue',   rgb: [0.133, 0.545, 0.902] },   // #228be6
  { name: 'Yellow', rgb: [0.980, 0.690, 0.020] },   // #fab005
];

/** Highlighter ink is pale on purpose, so it gets its own row. */
const HIGHLIGHT_PALETTE = [
  { name: 'Yellow', rgb: [1.00, 0.925, 0.600] },    // #ffec99
  { name: 'Green',  rgb: [0.698, 0.949, 0.733] },   // #b2f2bb
  { name: 'Blue',   rgb: [0.647, 0.847, 1.000] },   // #a5d8ff
  { name: 'Red',    rgb: [1.00, 0.788, 0.788] },    // #ffc9c9
];

const DEFAULT_MARKUP_COLOR = HIGHLIGHT_PALETTE[0].rgb;
const DEFAULT_INK_COLOR = PALETTE[0].rgb;

/** Tools that draw ink (as opposed to marking up existing text). */
const INK_TOOLS = new Set(['square', 'circle', 'line', 'arrow', 'ink', 'freetext']);

/** Excalidraw-style discrete choices rather than a continuous slider. */
const STROKE_STEPS = [{ label: 'Thin', w: 1.5, h: 2 },
                      { label: 'Bold', w: 3, h: 3.5 },
                      { label: 'Extra bold', w: 6, h: 5.5 }];
const FONT_STEPS = [{ label: 'S', mul: 0.7 }, { label: 'M', mul: 1 },
                    { label: 'L', mul: 1.5 }, { label: 'XL', mul: 2.2 }];

/** Side of a note icon, in PDF points. Must match lib/pdf-writer.js.
 *  Notes are no longer a tool, but files may still contain them. */
const NOTE_SIZE = 20;

const TEXT_MARKUP = new Set(['highlight', 'underline', 'strikeout']);
const RECT_TOOLS  = new Set(['square', 'circle']);
const DRAG_TOOLS  = new Set(['square', 'circle', 'line', 'arrow']);
const RESIZABLE   = new Set(['square', 'circle', 'image', 'freetext']);

// ------------------------------------------------------------------- state

const state = {
  doc: null,
  originalBytes: null,
  path: null,
  name: null,
  pages: [],
  scale: 1,
  zoomMode: 'fit',            // 'fit' | 'fit-width' | 'manual'
  tool: 'select',
  markupColor: DEFAULT_MARKUP_COLOR.slice(),
  inkColor: DEFAULT_INK_COLOR.slice(),
  strokeStep: 1,
  fontStep: 1,
  annots: [],
  images: {},
  selectedId: null,
  undo: [],
  redo: [],
  dirty: false,
  busy: false,
  autosave: true,
  imported: [],
  readOnlyMarks: false,
  theme: 'light',
  observer: null,
  currentPage: 0,
};

const $ = (sel) => document.querySelector(sel);

/** The colour the current tool should use. */
const toolColor = (tool = state.tool) =>
  (INK_TOOLS.has(tool) ? state.inkColor : state.markupColor).slice();

/**
 * How much bigger this page is than US Letter. Slide decks run 1920pt wide,
 * where a 14pt label and a 2pt stroke are invisible specks, so every default
 * size is expressed relative to the page rather than in absolute points.
 */
/** Legible text size for this page: ~13pt on Letter at the M step, scaled up
 *  for large pages, and multiplied by the chosen S/M/L/XL step. */
const defaultFontSize = (page) => Math.round(Math.min(120, Math.max(10,
  13 * docScale(page) * FONT_STEPS[state.fontStep].mul)));

/** A new text box should be just big enough to start typing in -- it grows to
 *  fit as you type, so starting it at half the page was far too large. */
const defaultTextWidth = (page) => {
  const vp = page.pdfPage.getViewport({ scale: 1 });
  return Math.min(vp.width * 0.34, defaultFontSize(page) * 11);
};

/** Stroke width in PDF points for the current step, scaled to the page. */
function strokeWidthFor(page) {
  return STROKE_STEPS[state.strokeStep].w * docScale(page);
}

function docScale(page) {
  const vp = page.pdfPage.getViewport({ scale: 1 });
  return Math.min(6, Math.max(0.6, Math.max(vp.width, vp.height) / 792));
}
const uid = () => 'a' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------- toast

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5200 : 2400);
}

let lastDirty = null;
function setStatus() {
  // Keep the main process in step: it owns the close confirmation.
  if (state.dirty !== lastDirty) {
    lastDirty = state.dirty;
    window.api.setDirty(state.dirty);
  }
  const bits = [];
  if (state.name) bits.push(state.name);
  if (state.doc) {
    bits.push(`Page ${(state.currentPage || 0) + 1} of ${state.doc.numPages}`);
  }
  if (state.annots.length) bits.push(`${state.annots.length} annotation${state.annots.length > 1 ? 's' : ''}`);
  const sel = state.annots.find((a) => a.id === state.selectedId);
  if (sel) {
    bits.push(sel.type === 'image'
      ? `image selected · ${Math.round(sel.rotation || 0)}°`
      : `${sel.type} selected`);
  }
  const dirty = state.dirty
    ? (state.autosave ? ' <span class="dirty">• saving…</span>'
                      : ' <span class="dirty">• unsaved changes</span>')
    : (state.doc ? ' • saved' : '');
  $('#statusText').innerHTML = (bits.join('  ·  ') || 'No document open') + dirty;

  // Actions that need a document shouldn't look available without one.
  // No Save button: the document saves itself. Undo is the safety net.
  const undoBtn = $('#undoBtn'), redoBtn = $('#redoBtn');
  if (undoBtn) undoBtn.disabled = !state.doc || !state.undo.length;
  if (redoBtn) redoBtn.disabled = !state.doc || !state.redo.length;
}

// ------------------------------------------------------------------ history

function snapshot() {
  state.undo.push(clone(state.annots));
  if (state.undo.length > 100) state.undo.shift();
  state.redo.length = 0;
  markChanged();
}

/** Mark the document changed and queue an autosave. */
function markChanged() {
  state.dirty = true;
  scheduleAutosave();
}

/**
 * Save automatically a moment after you stop working, straight back to the
 * file you opened. Manual ⌘S still works; this just means you do not lose
 * anything by forgetting it.
 */
let autosaveTimer = null;
function scheduleAutosave() {
  if (!state.autosave || !state.doc || !state.path) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (state.dirty && !state.busy && !editor) save(false, { quiet: true });
  }, 1200);
}
function undo() {
  commitEditor();
  if (!state.undo.length) return toast('Nothing to undo');
  state.redo.push(clone(state.annots));
  state.annots = state.undo.pop();
  state.selectedId = null;
  markChanged();
  redrawAll();
}
function redo() {
  commitEditor();
  if (!state.redo.length) return toast('Nothing to redo');
  state.undo.push(clone(state.annots));
  state.annots = state.redo.pop();
  state.selectedId = null;
  markChanged();
  redrawAll();
}

// -------------------------------------------------------------- coordinates

/** Client (screen) point -> PDF user-space point on `page`.
 *  viewport.convertToPdfPoint inverts rotation and CropBox offset for us, so
 *  rotated and offset pages need no special-casing here. */
function toPdf(page, clientX, clientY) {
  const r = page.canvas.getBoundingClientRect();
  const vx = (clientX - r.left) * (page.viewport.width / r.width);
  const vy = (clientY - r.top) * (page.viewport.height / r.height);
  return page.viewport.convertToPdfPoint(vx, vy);
}

/** PDF user-space point -> SVG overlay coordinates (unscaled viewport units). */
function toView(page, x, y) {
  return page.viewport.convertToViewportPoint(x, y);
}

/** PDF user-space point on `page` -> client (screen) coordinates. Inverse of
 *  toPdf, and needed to carry a mark from one page's frame into another's. */
function pdfToClient(page, x, y) {
  const r = page.canvas.getBoundingClientRect();
  const [vx, vy] = toView(page, x, y);
  return [r.left + vx * (r.width / page.viewport.width),
          r.top + vy * (r.height / page.viewport.height)];
}

/** The page whose element contains, or is nearest to, a client point. */
function pageAt(clientX, clientY) {
  for (const p of state.pages) {
    const r = p.el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return p;
  }
  return null;
}

/** The page occupying most of the viewport -- where pasted content lands. */
function currentPage() {
  const vr = $('#viewer').getBoundingClientRect();
  let best = null, bestArea = -1;
  for (const p of state.pages) {
    const r = p.el.getBoundingClientRect();
    const h = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
    if (h > bestArea) { bestArea = h; best = p; }
  }
  return best;
}

// ------------------------------------------------------------ affine helpers

/** Compose two affine transforms in [a,b,c,d,e,f] form: apply A, then B.
 *  Matches both pdf.js viewport.transform and the SVG matrix() convention:
 *  x' = a·x + c·y + e,  y' = b·x + d·y + f. */
function mul(A, B) {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}
const applyM = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

const normRect = (r) => {
  const x0 = Math.min(r.x, r.x + r.w), x1 = Math.max(r.x, r.x + r.w);
  const y0 = Math.min(r.y, r.y + r.h), y1 = Math.max(r.y, r.y + r.h);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0,
           cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
};

/** Maps the unit square (y-up, as in PDF) onto a placed, rotated image in PDF
 *  user space. This is byte-for-byte the same matrix the PDF writer emits, so
 *  what is drawn on screen is what is written to the file. */
function imageMatrix(a) {
  const { w, h, cx, cy } = normRect(a.rect);
  const th = -(a.rotation || 0) * Math.PI / 180;   // see lib/pdf-writer.js
  const cos = Math.cos(th), sin = Math.sin(th);
  return [w * cos, w * sin, -h * sin, h * cos,
          cx - (w * cos - h * sin) / 2, cy - (w * sin + h * cos) / 2];
}

/** Unit square -> SVG overlay coordinates. The extra flip accounts for <image>
 *  measuring y downward from its top edge while PDF measures y upward. */
const FLIP = [1, 0, 0, -1, 0, 1];
function imageViewMatrix(page, a) {
  return mul(mul(FLIP, imageMatrix(a)), page.viewport.transform);
}

/** The image's four on-screen corners, in draw order. */
function imageCorners(page, a) {
  const M = imageViewMatrix(page, a);
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => applyM(M, u, v));
}

/** Rotate a PDF-space point back into the image's own unrotated frame. */
function unrotatePoint(a, x, y) {
  const { cx, cy } = normRect(a.rect);
  const th = (a.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

// ------------------------------------------------------------ text metrics

/** Helvetica text measurement, used so on-screen wrapping matches the
 *  wrapping the PDF writer produces. Both use Adobe Helvetica metrics. */
const measureCanvas = document.createElement('canvas').getContext('2d');
/** Must name the same face the writer embeds, or on-screen wrapping and the
 *  wrapping in the saved file drift apart. */
const TEXT_FONT_STACK = `'EB Garamond', Georgia, serif`;
function measure(text, size) {
  measureCanvas.font = `${size}px ${TEXT_FONT_STACK}`;
  return measureCanvas.measureText(text).width;
}
/** Break a single word that is wider than the box, character by character, so
 *  nothing can run off the edge and out of sight. */
function breakLongWord(word, size, maxWidth, out) {
  let piece = '';
  for (const ch of word) {
    if (piece && measure(piece + ch, size) > maxWidth) {
      out.push(piece);
      piece = ch;
    } else piece += ch;
  }
  return piece;
}

function wrapText(text, size, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const cand = line + word;
      if (line && measure(cand, size) > maxWidth) {
        out.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      } else line = cand;

      // A word longer than the whole box cannot be placed by wrapping alone.
      if (measure(line, size) > maxWidth) {
        line = breakLongWord(line, size, maxWidth, out);
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

// ------------------------------------------------------------- document i/o

async function openDocument(result) {
  // Commit against the document still on screen, before anything is swapped.
  commitEditor();
  if (!result.ok) {
    if (!result.canceled) toast(result.error || 'Could not open that file.', true);
    return;
  }
  const bytes = new Uint8Array(result.data);
  state.originalBytes = bytes;                 // kept so saves are idempotent

  try {
    // getDocument transfers its buffer to the worker, so hand it a copy.
    state.doc = await pdfjsLib.getDocument({ data: bytes.slice(), }).promise;
  } catch (e) {
    toast(`Could not read the PDF: ${e.message}`, true);
    return;
  }

  state.path = result.path;
  state.name = result.name;
  state.annots = [];
  state.images = {};
  state.undo = []; state.redo = [];
  state.selectedId = null;
  state.dirty = false;

  // Fit the document to the window before the first render, so it never
  // appears at some arbitrary zoom and then jump.
  state.zoomMode = state.zoomMode === 'manual' ? 'fit' : state.zoomMode;
  state.scale = await fitScale();
  state.currentPage = 0;

  state.autosave = await window.api.autosaveAllowed();
  await importExistingMarks(bytes);

  await renderAllPages();
  $('#viewer').scrollTop = 0;
  updateZoomLabel();
  $('#empty').classList.add('hidden');
  $('#pages').classList.add('ready');
  refreshDocName();
  setStatus();
  toast(`Opened ${result.name}`);
}

/**
 * Lay out every page immediately, but only rasterise the ones near the
 * viewport. A long document has to open at once, the way Preview does --
 * rendering all of it up front stalls the window for seconds on a big file.
 */
/** PDF subtype -> the kind of mark this app edits. */
const IMPORTABLE = {
  Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout',
  Square: 'square', Circle: 'circle', Line: 'line', Ink: 'ink',
  FreeText: 'freetext', Text: 'note', Stamp: 'image',
};

/** Subtypes that are part of the document, not markup: leave them alone. */
const NOT_MARKUP = new Set(['Link', 'Popup', 'Widget', 'Screen', 'Movie',
  'PrinterMark', 'TrapNet', 'Watermark', '3D', 'Projection', 'RichMedia']);

/**
 * Take over the marks already in the file so they can be moved, retyped and
 * deleted -- not just looked at.
 *
 * Everything is read from the PDF itself (via the writer, which also recovers
 * pasted images from their appearance streams) and identified by position in
 * the page's /Annots array. An earlier version keyed on /NM and fell back to
 * read-only for any file whose annotations had no names -- which is most files
 * another editor has touched.
 */
async function importExistingMarks(bytes) {
  state.imported = [];
  state.readOnlyMarks = false;

  const reply = await window.api.existingMarks(bytes);
  if (!reply.ok) { state.readOnlyMarks = true; return; }

  const found = [];
  const positions = [];
  let unsupported = false;

  for (const raw of reply.marks || []) {
    if (NOT_MARKUP.has(raw.subtype)) continue;
    const kind = IMPORTABLE[raw.subtype];
    if (!kind) { unsupported = true; continue; }
    if (kind === 'image' && !raw.image) { unsupported = true; continue; }

    const a = markFromExisting(raw, kind);
    if (!a) { unsupported = true; continue; }
    found.push(a);
    positions.push({ page: raw.page, index: raw.index });
  }

  if (unsupported) {
    // Something in here cannot be rebuilt faithfully. Leave the whole file as
    // the renderer paints it and only add new marks, rather than risk dropping
    // someone's work on the next save.
    state.readOnlyMarks = true;
    return;
  }
  state.annots = found;
  state.imported = positions;
}

/** Build an editable mark from a raw annotation read out of the PDF. */
function markFromExisting(raw, kind) {
  const colour = (c, fallback) => (Array.isArray(c) && c.length >= 3)
    ? c.slice(0, 3) : fallback.slice();
  const r = raw.rect || [0, 0, 0, 0];
  const rect = { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]),
                 w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) };
  const base = { id: uid(), page: raw.page, type: kind,
                 color: colour(raw.color, DEFAULT_INK_COLOR) };
  const stroke = raw.strokeWidth || 2;

  if (TEXT_MARKUP.has(kind)) {
    const quads = normaliseQuads(raw.quadPoints);
    if (!quads.length) return null;
    return { ...base, quads, contents: raw.contents || '' };
  }
  if (kind === 'square' || kind === 'circle') {
    // The writer pads the rect by half the stroke; undo that on the way back.
    const pad = stroke / 2;
    return { ...base, strokeWidth: stroke,
             rect: { x: rect.x + pad, y: rect.y + pad,
                     w: Math.max(1, rect.w - stroke), h: Math.max(1, rect.h - stroke) } };
  }
  if (kind === 'line') {
    if (!raw.line) return null;
    return { ...base, type: raw.arrow ? 'arrow' : 'line', strokeWidth: stroke,
             points: [[raw.line[0], raw.line[1]], [raw.line[2], raw.line[3]]] };
  }
  if (kind === 'ink') {
    const paths = (raw.inkList || []).map((flat) => {
      const pts = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
      return pts;
    }).filter((p) => p.length > 1);
    if (!paths.length) return null;
    return { ...base, paths, strokeWidth: stroke };
  }
  if (kind === 'freetext') {
    const text = raw.contents || '';
    const size = fontSizeFromDA(raw.da) || 14;
    const a = { ...base, rect, fontSize: size, text };
    a.lines = wrapText(text, size, Math.max(4, rect.w - 4));
    return a;
  }
  if (kind === 'note') {
    const size = rect.w || NOTE_SIZE;
    return { ...base, size, text: raw.contents || '',
             rect: { x: rect.x, y: rect.y + rect.h, w: size, h: size } };
  }
  if (kind === 'image') {
    const id = uid();
    state.images[id] = raw.image.data;
    return { ...base, type: 'image', imageId: id, rect, rotation: 0 };
  }
  return null;
}

/**
 * Quad points arrive as a flat run of numbers. Rebuild them in the order the
 * writer uses: upper-left, upper-right, lower-left, lower-right.
 */
function normaliseQuads(flat) {
  if (!flat || !flat.length) return [];
  const out = [];
  for (let i = 0; i + 7 < flat.length; i += 8) {
    const xs = [flat[i], flat[i + 2], flat[i + 4], flat[i + 6]];
    const ys = [flat[i + 1], flat[i + 3], flat[i + 5], flat[i + 7]];
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    out.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  return out;
}

/** Pull the point size out of a /DA string like "1 0 0 rg /AnnotFont 18 Tf". */
function fontSizeFromDA(da) {
  const m = typeof da === 'string' && da.match(/([\d.]+)\s+Tf/);
  return m ? parseFloat(m[1]) : null;
}

async function renderAllPages() {
  const container = $('#pages');
  container.innerHTML = '';
  if (state.observer) state.observer.disconnect();
  state.pages = [];

  const dpr = window.devicePixelRatio || 1;

  for (let n = 1; n <= state.doc.numPages; n++) {
    const pdfPage = await state.doc.getPage(n);
    const viewport = pdfPage.getViewport({ scale: state.scale });

    const el = document.createElement('div');
    el.className = 'page';
    el.style.width = `${viewport.width}px`;
    el.style.height = `${viewport.height}px`;
    // pdf.js lays the text layer out with calc(var(--scale-factor)*...); without
    // this the spans render at their natural browser width and every
    // selection-derived rectangle comes out too wide.
    el.style.setProperty('--scale-factor', String(state.scale));

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    el.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    // Must go through pdf.js's own helper: on a /Rotate 90 or /Rotate 270 page
    // the text layer needs the rotation baked into its dimensions and
    // transform. Setting width/height by hand leaves every span in the wrong
    // place, which silently corrupts anything derived from a text selection.
    pdfjsLib.setLayerDimensions(textLayerDiv, viewport);
    el.appendChild(textLayerDiv);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'overlay');
    svg.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    el.appendChild(svg);

    const label = document.createElement('div');
    label.className = 'pageLabel';
    label.textContent = `${n} of ${state.doc.numPages}`;
    el.appendChild(label);

    container.appendChild(el);

    const page = { num: n, index: n - 1, pdfPage, viewport, el, canvas, svg,
                   textLayerDiv, rendered: false, rendering: null };
    state.pages.push(page);
    el.__page = page;
    attachPageHandlers(page);
  }

  // Render a screenful either side of the viewport so scrolling stays ahead
  // of the user.
  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) renderPageContent(entry.target.__page);
    }
  }, { root: $('#viewer'), rootMargin: '800px 0px' });
  for (const p of state.pages) state.observer.observe(p.el);

  applyToolMode();
  redrawAll();

  // Always have the first pages ready before handing control back, so the
  // window never shows blank paper.
  await Promise.all(state.pages.slice(0, 2).map(renderPageContent));
}

/** Rasterise one page and build its selectable text layer. Idempotent. */
function renderPageContent(page) {
  if (!page || page.rendered) return Promise.resolve();
  if (page.rendering) return page.rendering;

  const dpr = window.devicePixelRatio || 1;
  page.rendering = (async () => {
    // Annotations already in the file are painted by pdf.js into the canvas
    // (annotationMode defaults to ENABLE), so reopened work shows up as-is.
    await page.pdfPage.render({
      canvasContext: page.canvas.getContext('2d'),
      viewport: page.viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      // Marks we have taken over are drawn by us, so pdf.js must not paint
      // them too. When we could not take them all over, it paints everything
      // and they simply stay read-only.
      annotationMode: state.readOnlyMarks
        ? pdfjsLib.AnnotationMode.ENABLE
        : pdfjsLib.AnnotationMode.DISABLE,
    }).promise;

    const textContent = await page.pdfPage.getTextContent();

    // Keep the PDF's own text metrics: baseline and font size per run, in PDF
    // user space. Browser line boxes are taller than the glyphs, so these are
    // what we snap highlight bands to.
    page.textItems = textContent.items
      .filter((i) => i.str && i.str.trim() && i.transform)
      .map((i) => {
        const style = textContent.styles[i.fontName] || {};
        return {
          x0: i.transform[4],
          x1: i.transform[4] + (i.width || 0),
          baseline: i.transform[5],
          size: Math.hypot(i.transform[2], i.transform[3]) || i.height || 0,
          ascent: style.ascent,
          descent: style.descent,
        };
      })
      .filter((i) => i.size > 0);

    page.textLayerDiv.replaceChildren();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent, container: page.textLayerDiv,
      viewport: page.viewport,
    });
    await textLayer.render();

    page.rendered = true;
    page.rendering = null;
    drawPage(page);
  })().catch((e) => {
    page.rendering = null;
    console.error(`page ${page.num} failed to render:`, e);
  });

  return page.rendering;
}

/** Force a specific page to be ready -- used before acting on its text. */
async function ensurePageRendered(index) {
  const page = state.pages[index];
  if (page) await renderPageContent(page);
  return page;
}

const clampScale = (v) => Math.min(6, Math.max(0.1, v));

/** Space a page actually has, once padding, the page label and any scrollbar
 *  are accounted for. */
function availableSpace() {
  const viewer = $('#viewer');
  return {
    w: Math.max(80, viewer.clientWidth - 48),
    h: Math.max(80, viewer.clientHeight - 60),
  };
}

/** Scale that satisfies the current zoom mode. Measured from the first page,
 *  which is what every other viewer keys off too. */
async function fitScale(mode = state.zoomMode) {
  const first = await state.doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const { w, h } = availableSpace();
  return clampScale(mode === 'fit-width'
    ? w / vp.width
    : Math.min(w / vp.width, h / vp.height));
}

function updateZoomLabel() {
  $('#zoomLabel').textContent = state.zoomMode === 'fit'
    ? 'Fit' : `${Math.round(state.scale * 100)}%`;
}

/** Re-render at a new scale, keeping the reader where they were. */
async function reflow(newScale, mode = 'manual') {
  if (!state.doc) return;
  // Re-rendering rebuilds every page, and the editor lives inside one of them,
  // so commit before zooming or what is being typed is thrown away.
  commitEditor();
  const anchor = scrollAnchor();
  state.zoomMode = mode;
  state.scale = clampScale(newScale);
  updateZoomLabel();
  await renderAllPages();
  restoreScroll(anchor);
}

/** Re-apply the current fit mode -- on open, and whenever the window resizes. */
async function applyFit(mode = state.zoomMode) {
  if (!state.doc || mode === 'manual') return;
  await reflow(await fitScale(mode), mode);
}

/** Which page is at the top of the viewport, and how far into it we are. */
function scrollAnchor() {
  const viewer = $('#viewer');
  const top = viewer.getBoundingClientRect().top;
  for (const p of state.pages) {
    const r = p.el.getBoundingClientRect();
    if (r.bottom > top + 1) {
      return { index: p.index, offset: (top - r.top) / Math.max(1, r.height) };
    }
  }
  return null;
}

function restoreScroll(anchor) {
  if (!anchor) return;
  const page = state.pages[anchor.index];
  if (!page) return;
  const viewer = $('#viewer');
  const r = page.el.getBoundingClientRect();
  viewer.scrollTop += (r.top - viewer.getBoundingClientRect().top)
                      + anchor.offset * r.height;
}

/** Page number shown in the status bar, following the scroll. */
function updatePageIndicator() {
  if (!state.pages.length) return;
  const a = scrollAnchor();
  if (a && a.index !== state.currentPage) {
    state.currentPage = a.index;
    setStatus();
  }
}

// ------------------------------------------------------------------ drawing

const SVGNS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

function redrawAll() {
  for (const page of state.pages) drawPage(page);
  setStatus();
  refreshPanel();
}

function drawPage(page) {
  // While a box is being edited the textarea shows its text. Painting the
  // annotation as well would double every glyph, and the selection outline
  // would sit on top of the editor's own border.
  const editingId = editor ? editor.a.id : null;

  page.svg.innerHTML = '';
  for (const a of state.annots) {
    if (a.page !== page.index || a.id === editingId) continue;
    const g = renderAnnot(page, a);
    if (g) page.svg.appendChild(g);
  }
  if (state.selectedId && state.selectedId !== editingId) {
    const a = state.annots.find((x) => x.id === state.selectedId);
    if (a && a.page === page.index) page.svg.appendChild(selectionChrome(page, a));
  }
  updateNotePopup(page);
}

/**
 * A note is just a small icon, so its contents are invisible until you open it.
 * Show the text beside the icon while the note is selected -- the same idea as
 * Preview's note popup.
 */
function updateNotePopup(page) {
  for (const el of page.el.querySelectorAll('.notePopup')) el.remove();
  if (editor) return;                       // the editor is already showing it
  const a = state.annots.find((x) => x.id === state.selectedId);
  if (!a || a.type !== 'note' || a.page !== page.index) return;

  const b = viewBox(page, a);
  const div = document.createElement('div');
  div.className = 'notePopup';
  div.textContent = a.text ? a.text : 'Empty note — double-click to write in it';
  if (!a.text) div.classList.add('empty');
  div.style.left = `${b.x + b.w + 8}px`;
  div.style.top = `${b.y}px`;
  div.style.maxWidth = `${Math.max(140, page.viewport.width * 0.3)}px`;
  div.addEventListener('dblclick', (e) => { e.stopPropagation(); openEditor(page, a); });
  page.el.appendChild(div);
}

/** Axis-aligned view-space box for any annotation, used for hit areas,
 *  the selection outline and resize handles. */
function viewBox(page, a) {
  const pts = [];
  const push = (x, y) => pts.push(toView(page, x, y));
  if (a.type === 'image') {
    for (const [x, y] of imageCorners(page, a)) pts.push([x, y]);
  } else if (a.type === 'note') {
    // The writer emits exactly [x, y-size, x+size, y]; the on-screen box has to
    // be the same one, or the icon is drawn where the file does not contain it.
    const sz = a.size || NOTE_SIZE;
    push(a.rect.x, a.rect.y - sz);
    push(a.rect.x + sz, a.rect.y);
  } else if (a.rect) {
    const { x, y, w = 0, h = 0 } = a.rect;
    push(x, y); push(x + w, y + h);
  }
  if (a.quads) for (const q of a.quads) for (let i = 0; i < 8; i += 2) push(q[i], q[i + 1]);
  if (a.points) for (const p of a.points) push(p[0], p[1]);
  if (a.paths) for (const path of a.paths) for (const p of path) push(p[0], p[1]);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys),
           w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function renderAnnot(page, a) {
  const g = mk('g', { 'data-id': a.id });
  // Image annotations carry no colour -- everything else does.
  const col = a.color ? css(a.color) : '#000';
  const sw = (a.strokeWidth || 2) * state.scale;

  const quadRects = () => (a.quads || []).map((q) => {
    const [x0, y0] = toView(page, q[4], q[5]);      // lower-left
    const [x1, y1] = toView(page, q[2], q[3]);      // upper-right
    return { x: Math.min(x0, x1), y: Math.min(y0, y1),
             w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  });

  switch (a.type) {
    case 'highlight':
      for (const r of quadRects()) {
        g.appendChild(mk('rect', { x: r.x, y: r.y, width: r.w, height: r.h,
          fill: col, style: 'mix-blend-mode:multiply' }));
      }
      break;
    case 'underline':
    case 'strikeout':
      for (const r of quadRects()) {
        const t = Math.max(1, r.h * 0.07);
        const y = a.type === 'underline' ? r.y + r.h * 0.94 - t : r.y + r.h * 0.52;
        g.appendChild(mk('rect', { x: r.x, y, width: r.w, height: t, fill: col }));
      }
      break;
    case 'square': {
      const b = viewBox(page, a);
      g.appendChild(mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h,
        fill: 'none', stroke: col, 'stroke-width': sw }));
      break;
    }
    case 'circle': {
      const b = viewBox(page, a);
      g.appendChild(mk('ellipse', { cx: b.x + b.w / 2, cy: b.y + b.h / 2,
        rx: Math.max(0.5, b.w / 2), ry: Math.max(0.5, b.h / 2),
        fill: 'none', stroke: col, 'stroke-width': sw }));
      break;
    }
    case 'line':
    case 'arrow': {
      const [p0, p1] = a.points.map((p) => toView(page, p[0], p[1]));
      g.appendChild(mk('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1],
        stroke: col, 'stroke-width': sw, 'stroke-linecap': 'round' }));
      if (a.type === 'arrow') {
        const head = Math.max(6, (a.strokeWidth || 2) * 3.5) * state.scale;
        const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const wing = 0.42;
        const a1 = [p1[0] - head * Math.cos(ang - wing), p1[1] - head * Math.sin(ang - wing)];
        const a2 = [p1[0] - head * Math.cos(ang + wing), p1[1] - head * Math.sin(ang + wing)];
        g.appendChild(mk('path', {
          d: `M${p1[0]} ${p1[1]} L${a1[0]} ${a1[1]} L${a2[0]} ${a2[1]} Z`, fill: col }));
      }
      break;
    }
    case 'ink':
      for (const path of a.paths) {
        const d = path.map((p, i) => {
          const [x, y] = toView(page, p[0], p[1]);
          return `${i ? 'L' : 'M'}${x} ${y}`;
        }).join(' ');
        g.appendChild(mk('path', { d, fill: 'none', stroke: col,
          'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }
      break;
    case 'freetext': {
      const b = viewBox(page, a);
      const size = (a.fontSize || 14) * state.scale;
      const pad = 2 * state.scale;
      const lines = a.lines || wrapText(a.text || '', a.fontSize || 14,
        Math.max(4, a.rect.w - 4));
      const t = mk('text', {
        x: b.x + pad, y: b.y + pad + size * 0.85,
        fill: col, 'font-family': TEXT_FONT_STACK,
        'font-size': size, 'xml:space': 'preserve',
      });
      lines.forEach((l, i) => {
        const ts = mk('tspan', { x: b.x + pad, dy: i ? size * 1.2 : 0 });
        ts.textContent = l || ' ';
        t.appendChild(ts);
      });
      g.appendChild(t);
      break;
    }
    case 'note': {
      const b = viewBox(page, a);
      g.appendChild(mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 2 * state.scale,
        fill: col, stroke: 'rgba(60,45,20,.75)', 'stroke-width': Math.max(1, state.scale) }));
      for (const f of [0.32, 0.5, 0.68]) {
        g.appendChild(mk('line', {
          x1: b.x + b.w * 0.2, y1: b.y + b.h * f, x2: b.x + b.w * 0.8, y2: b.y + b.h * f,
          stroke: 'rgba(60,45,20,.75)', 'stroke-width': Math.max(0.8, state.scale * 0.8) }));
      }
      const title = mk('title', {});
      title.textContent = a.text || '(empty note)';
      g.appendChild(title);
      break;
    }
    case 'image': {
      // Drawn through the same matrix the writer uses, so rotation on screen
      // and rotation in the saved file cannot drift apart.
      const M = imageViewMatrix(page, a);
      g.appendChild(mk('image', {
        x: 0, y: 0, width: 1, height: 1,
        preserveAspectRatio: 'none',
        transform: `matrix(${M.join(' ')})`,
        href: `data:image/png;base64,${state.images[a.imageId]}`,
      }));
      break;
    }
    default: return null;
  }

  // A transparent hit area so thin strokes and text stay easy to grab.
  const b = viewBox(page, a);
  if (b) {
    const pad = 3;
    const hit = mk('rect', {
      x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
      fill: 'transparent', class: 'hit movable', 'data-id': a.id,
    });
    g.appendChild(hit);
  }
  return g;
}

function selectionChrome(page, a) {
  const g = mk('g', { class: 'selection' });
  const s = 8;
  const handle = (x, y, attrs) => mk('rect', {
    class: 'handle hit', x: x - s / 2, y: y - s / 2, width: s, height: s,
    'data-id': a.id, ...attrs,
  });

  if (a.type === 'image') {
    // Outline and handles follow the image's actual rotated corners.
    const c = imageCorners(page, a);
    g.appendChild(mk('polygon', { class: 'selbox',
      points: c.map((p) => p.join(',')).join(' ') }));

    // Unit-square corners map to: (0,0) top-left .. (0,1) bottom-left.
    const dirs = ['nw', 'ne', 'se', 'sw'];
    c.forEach(([x, y], i) => g.appendChild(handle(x, y, { 'data-handle': dirs[i] })));

    // Rotate grip, held off the top edge along the image's own "up".
    const midTop = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
    const midBot = [(c[3][0] + c[2][0]) / 2, (c[3][1] + c[2][1]) / 2];
    const len = Math.hypot(midTop[0] - midBot[0], midTop[1] - midBot[1]) || 1;
    const ux = (midTop[0] - midBot[0]) / len, uy = (midTop[1] - midBot[1]) / len;
    const grip = [midTop[0] + ux * 22, midTop[1] + uy * 22];
    g.appendChild(mk('line', { class: 'rotstem',
      x1: midTop[0], y1: midTop[1], x2: grip[0], y2: grip[1] }));
    g.appendChild(mk('circle', { class: 'rothandle hit',
      cx: grip[0], cy: grip[1], r: 5.5, 'data-handle': 'rotate', 'data-id': a.id }));
    return g;
  }

  const b = viewBox(page, a);
  if (!b) return g;
  g.appendChild(mk('rect', { class: 'selbox',
    x: b.x - 2, y: b.y - 2, width: b.w + 4, height: b.h + 4 }));
  if (RESIZABLE.has(a.type)) {
    for (const [x, y, dir] of [[b.x, b.y, 'nw'], [b.x + b.w, b.y, 'ne'],
                               [b.x, b.y + b.h, 'sw'], [b.x + b.w, b.y + b.h, 'se']]) {
      g.appendChild(handle(x, y, { 'data-handle': dir }));
    }
  }
  return g;
}

// -------------------------------------------------------------- interaction

function applyToolMode() {
  const textMode = state.tool === 'select' || TEXT_MARKUP.has(state.tool);
  for (const p of state.pages) {
    p.textLayerDiv.classList.toggle('inert', !textMode);
    p.svg.classList.toggle('inert', TEXT_MARKUP.has(state.tool));
    p.svg.classList.toggle('drawing', !textMode);
  }
  for (const b of document.querySelectorAll('.tool')) {
    b.classList.toggle('active', b.dataset.tool === state.tool);
  }
}

function setTool(id) {
  commitEditor();
  state.tool = id;
  if (!TEXT_MARKUP.has(id) && id !== 'select') state.selectedId = null;
  applyToolMode();
  refreshSwatches();
  redrawAll();

  // Pick the tool and the box is there, ready to type in.
  if (id === 'freetext' && state.doc) {
    const page = currentPage();
    if (page) {
      const [cx, cy] = viewCentreInPdf(page);
      createTextual(page, id, cx, cy);
    }
  }
}

/** Place a text box or a note and open it for typing straight away. */
function createTextual(page, kind, x, y) {
  const scale = docScale(page);
  snapshot();
  const a = kind === 'freetext'
    ? { id: uid(), page: page.index, type: 'freetext',
        color: toolColor('freetext'), fontSize: defaultFontSize(page),
        rect: { x: x - defaultTextWidth(page) / 2,
                y: y - defaultFontSize(page) * 0.8,
                w: defaultTextWidth(page), h: defaultFontSize(page) * 1.6 },
        text: '' }
    : { id: uid(), page: page.index, type: 'note',
        color: toolColor('note'), size: NOTE_SIZE * scale,
        rect: { x, y, w: NOTE_SIZE * scale, h: NOTE_SIZE * scale }, text: '' };
  state.annots.push(a);
  state.selectedId = a.id;
  redrawAll();
  openEditor(page, a, true);
  return a;
}

function attachPageHandlers(page) {
  page.svg.addEventListener('pointerdown', (e) => onPointerDown(page, e));
  // Fallback for the text-markup tools, where the overlay is inert and
  // pointerdown never reaches us. When the pointerdown path already handled
  // this gesture the editor is open, so leave it alone rather than tearing it
  // down and building it again.
  page.el.addEventListener('dblclick', (e) => {
    const a = annotationAt(page, e.clientX, e.clientY);
    if (!a) return;
    if (editor && editor.a.id === a.id) return;
    setToolQuiet('select');
    state.selectedId = a.id;
    redrawAll();
    if (a.type === 'freetext' || a.type === 'note') openEditor(page, a);
  });
}

/** Remembers the previous pointerdown so a double-click can be recognised by
 *  annotation id, independent of the DOM being rebuilt in between. */
let lastPointerDown = { id: null, at: 0 };

function onPointerDown(page, e) {
  if (e.button !== 0) return;

  // Which tool the click was made WITH. Finishing the open text box below
  // resets the tool to the arrow, so without capturing it first, clicking the
  // page to place a second box would instead just end the first one and leave
  // you with nothing -- and your typing would fall through to the shortcuts.
  const tool = state.tool;

  commitEditor();
  const targetId = e.target.dataset && e.target.dataset.id;
  const handle = e.target.dataset && e.target.dataset.handle;

  // --- dragging an existing annotation -----------------------------------
  if (handle && targetId === state.selectedId) {
    return handle === 'rotate'
      ? beginRotate(page, e)
      : beginResize(page, e, handle);
  }
  // Double-click reaches for whatever is under the pointer, whatever tool is
  // in hand: it selects the mark (and opens a text box for editing) without
  // making you go back to the arrow first.
  //
  // Detected by annotation id and timing rather than the browser's dblclick,
  // because selecting rebuilds the overlay and the node the first click landed
  // on no longer exists when the second arrives.
  const under = state.annots.find((x) => x.id === targetId)
    || annotationAt(page, e.clientX, e.clientY);
  const now = Date.now();
  const isSecond = under && lastPointerDown.id === under.id
    && now - lastPointerDown.at < 450;
  lastPointerDown = under ? { id: under.id, at: now } : { id: null, at: 0 };

  if (isSecond) {
    lastPointerDown = { id: null, at: 0 };
    setToolQuiet('select');
    state.selectedId = under.id;
    redrawAll();
    if (under.type === 'freetext' || under.type === 'note') {
      openEditor(page, under);
      return;
    }
    // For anything else, a quick second click is far more likely to be the
    // start of a drag than a request to do nothing -- select it and let the
    // move proceed.
    return beginMove(page, e, under.id);
  }

  if (targetId && (tool === 'select' || state.selectedId === targetId)) {
    state.selectedId = targetId;
    redrawAll();
    return beginMove(page, e, targetId);
  }
  if (tool === 'select') {
    if (state.selectedId) {
      state.selectedId = null;
      dropEmptyTextBoxes();
      redrawAll();
    }
    return;
  }

  // --- creating a new annotation ------------------------------------------
  const start = toPdf(page, e.clientX, e.clientY);

  if (tool === 'freetext') {
    // Clicking an existing box edits it; clicking bare page makes a new one.
    const hitText = annotationAt(page, e.clientX, e.clientY, 'freetext');
    if (hitText) {
      state.selectedId = hitText.id;
      redrawAll();
      openEditor(page, hitText);
      return;
    }
    createTextual(page, 'freetext', start[0], start[1]);
    return;
  }

  if (tool === 'ink') return beginInk(page, e, start);
  if (DRAG_TOOLS.has(tool)) return beginDrag(page, e, start, tool);
}

/** The topmost annotation of a given type under a client point, if any. */
function annotationAt(page, clientX, clientY, type = null) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const id = el.dataset && el.dataset.id;
    if (!id) continue;
    const a = state.annots.find((x) => x.id === id);
    if (a && (!type || a.type === type)) return a;
  }
  // Fall back to a geometric test, for clicks inside the box but off the glyphs.
  const [px, py] = toPdf(page, clientX, clientY);
  for (let i = state.annots.length - 1; i >= 0; i--) {
    const a = state.annots[i];
    if (a.page !== page.index) continue;
    if (type && a.type !== type) continue;
    const b = annotBounds(a);
    if (b && px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) return a;
  }
  return null;
}

function capture(page, onMove, onUp) {
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onUp(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function beginDrag(page, e, start, tool = state.tool) {
  const a = {
    id: uid(), page: page.index, type: tool,
    color: toolColor(), strokeWidth: strokeWidthFor(page),
  };
  if (RECT_TOOLS.has(tool)) a.rect = { x: start[0], y: start[1], w: 0, h: 0 };
  else a.points = [[start[0], start[1]], [start[0], start[1]]];
  state.annots.push(a);
  state.selectedId = null;

  capture(page, (ev) => {
    const p = toPdf(page, ev.clientX, ev.clientY);
    if (a.rect) {
      let w = p[0] - start[0], h = p[1] - start[1];
      // Shift constrains a rectangle to a square and an oval to a circle.
      if (ev.shiftKey) {
        const side = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * side;
        h = Math.sign(h || 1) * side;
      }
      a.rect.w = w; a.rect.h = h;
    } else {
      let [x, y] = p;
      // Shift snaps a line or arrow to 45 degree steps.
      if (ev.shiftKey) {
        const dx = x - start[0], dy = y - start[1];
        const len = Math.hypot(dx, dy);
        const step = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        x = start[0] + len * Math.cos(step);
        y = start[1] + len * Math.sin(step);
      }
      a.points[1] = [x, y];
    }
    drawPage(page);
  }, () => {
    const tiny = a.rect
      ? Math.abs(a.rect.w) < 3 && Math.abs(a.rect.h) < 3
      : Math.hypot(a.points[1][0] - a.points[0][0], a.points[1][1] - a.points[0][1]) < 3;
    if (tiny) {
      state.annots = state.annots.filter((x) => x !== a);
      drawPage(page);
      return;
    }
    if (a.rect) {                                    // normalise for later edits
      if (a.rect.w < 0) { a.rect.x += a.rect.w; a.rect.w = -a.rect.w; }
      if (a.rect.h < 0) { a.rect.y += a.rect.h; a.rect.h = -a.rect.h; }
    }
    const without = state.annots.filter((x) => x !== a);
    state.annots = without;
    snapshot();
    state.annots.push(a);
    redrawAll();
  });
}

function beginInk(page, e, start) {
  const a = {
    id: uid(), page: page.index, type: 'ink',
    color: toolColor(), strokeWidth: strokeWidthFor(page),
    paths: [[[start[0], start[1]]]],
  };
  state.annots.push(a);
  const path = a.paths[0];
  capture(page, (ev) => {
    const p = toPdf(page, ev.clientX, ev.clientY);
    const last = path[path.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.2) return;   // thin out
    path.push([p[0], p[1]]);
    drawPage(page);
  }, () => {
    if (path.length < 2) {
      state.annots = state.annots.filter((x) => x !== a);
      drawPage(page);
      return;
    }
    state.annots = state.annots.filter((x) => x !== a);
    snapshot();
    state.annots.push(a);
    redrawAll();
  });
}

function beginMove(page, e, id) {
  const a = state.annots.find((x) => x.id === id);
  if (!a) return;
  const before = clone(state.annots);
  const orig = clone(a);
  const startPage = page;
  const startBounds = annotBounds(a);
  if (!startBounds) return;

  // Where the pointer sits relative to the mark's top-left corner, on screen.
  // Carrying this offset rather than a coordinate delta is what lets the mark
  // cross onto another page, whose PDF frame is entirely its own.
  const anchorClient = pdfToClient(startPage, startBounds.x0, startBounds.y1);
  const grabX = e.clientX - anchorClient[0];
  const grabY = e.clientY - anchorClient[1];
  let moved = false;

  capture(page, (ev) => {
    if (Math.abs(ev.clientX - e.clientX) > 0.5 ||
        Math.abs(ev.clientY - e.clientY) > 0.5) moved = true;

    // Whichever page the pointer is over is the page the mark belongs to.
    const target = pageAt(ev.clientX, ev.clientY) || startPage;
    const anchor = toPdf(target, ev.clientX - grabX, ev.clientY - grabY);

    let dx = anchor[0] - startBounds.x0;
    let dy = anchor[1] - startBounds.y1;
    // Keep it on that page: off the edge it would be clipped out of the
    // overlay and sit in the file where no viewer draws it.
    [dx, dy] = clampDelta(a, orig, dx, dy, pageLimits(target));
    translate(a, orig, dx, dy);

    const previous = a.page;
    a.page = target.index;
    if (previous !== a.page) drawPage(state.pages[previous]);
    drawPage(target);
  }, () => {
    if (!moved) {
      a.page = orig.page;
      return;
    }
    const after = clone(state.annots);
    state.annots = before;
    snapshot();
    state.annots = after;
    redrawAll();
  });
}

/** The page's own extent in PDF user space. */
function pageLimits(page) {
  const { pageWidth, pageHeight, pageX = 0, pageY = 0 } = page.viewport.rawDims || {};
  return {
    x0: pageX || 0, y0: pageY || 0,
    x1: (pageX || 0) + (pageWidth || 612),
    y1: (pageY || 0) + (pageHeight || 792),
  };
}

/** Bounding box of an annotation in PDF user space. */
function annotBounds(a) {
  const pts = [];
  if (a.type === 'note') {
    const sz = a.size || NOTE_SIZE;
    pts.push([a.rect.x, a.rect.y - sz], [a.rect.x + sz, a.rect.y]);
  } else if (a.rect) {
    pts.push([a.rect.x, a.rect.y], [a.rect.x + a.rect.w, a.rect.y + a.rect.h]);
  }
  if (a.points) pts.push(...a.points);
  if (a.paths) for (const p of a.paths) pts.push(...p);
  if (a.quads) for (const q of a.quads) {
    for (let i = 0; i < 8; i += 2) pts.push([q[i], q[i + 1]]);
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys),
           x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Trim a drag so the annotation stays within the page. */
function clampDelta(a, orig, dx, dy, limits) {
  // Measured against where the mark started, since `orig` is what translate()
  // applies the delta to.
  const b = annotBounds({ ...a, ...orig, rect: orig.rect, points: orig.points,
                          paths: orig.paths, quads: orig.quads });
  if (!b) return [dx, dy];
  dx = Math.max(limits.x0 - b.x0, Math.min(limits.x1 - b.x1, dx));
  dy = Math.max(limits.y0 - b.y0, Math.min(limits.y1 - b.y1, dy));
  return [dx, dy];
}

function translate(a, orig, dx, dy) {
  if (orig.rect) a.rect = { ...orig.rect, x: orig.rect.x + dx, y: orig.rect.y + dy };
  if (orig.points) a.points = orig.points.map((p) => [p[0] + dx, p[1] + dy]);
  if (orig.paths) a.paths = orig.paths.map((path) => path.map((p) => [p[0] + dx, p[1] + dy]));
  if (orig.quads) a.quads = orig.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)));
}

function beginResize(page, e, dir) {
  const a = state.annots.find((x) => x.id === state.selectedId);
  if (!a || !a.rect) return;
  const before = clone(state.annots);
  const orig = clone(a.rect);
  // Measure the drag in the image's own unrotated frame, so dragging a corner
  // of a rotated image still grows it along its own edges.
  const localPoint = (cx, cy) => {
    const p = toPdf(page, cx, cy);
    return a.rotation ? unrotatePoint(a, p[0], p[1]) : p;
  };
  const start = localPoint(e.clientX, e.clientY);
  const west = dir.includes('w'), north = dir.includes('n');

  // A text box is sized by its words: you choose the width, the height follows.
  const textBox = a.type === 'freetext';

  // A pasted image keeps its proportions by default -- squashing a screenshot
  // is almost never what you meant. Hold Shift to distort it deliberately.
  const locksAspect = a.type === 'image';
  const aspect = orig.h !== 0 ? Math.abs(orig.w / orig.h) : 1;

  capture(page, (ev) => {
    const p = localPoint(ev.clientX, ev.clientY);
    const dx = p[0] - start[0], dy = p[1] - start[1];
    const r = { ...orig };
    // In PDF space "north" is +y, so a north handle moves the top edge.
    if (west) { r.x = orig.x + dx; r.w = orig.w - dx; } else { r.w = orig.w + dx; }
    if (north) { r.h = orig.h + dy; } else { r.y = orig.y + dy; r.h = orig.h - dy; }

    if (locksAspect && !ev.shiftKey && r.w > 0 && r.h > 0) {
      // Follow whichever edge the pointer moved further, then derive the other
      // from the original ratio, keeping the opposite corner pinned.
      if (Math.abs(dx) >= Math.abs(dy)) r.h = r.w / aspect;
      else r.w = r.h * aspect;
      if (west) r.x = orig.x + orig.w - r.w;
      if (!north) r.y = orig.y + orig.h - r.h;
    }

    if (r.w > 4 && r.h > 4) {
      a.rect = r;
      // Text has to re-wrap to the new width, or the box changes shape while
      // the words stay exactly where they were.
      if (a.type === 'freetext') reflowTextBox(a);
      drawPage(page);
    }
  }, () => {
    const after = clone(state.annots);
    state.annots = before;
    snapshot();
    state.annots = after;
    redrawAll();
  });
}

/** Free rotation by dragging the grip; hold Shift to snap to 15 degrees. */
function beginRotate(page, e) {
  const a = state.annots.find((x) => x.id === state.selectedId);
  if (!a || a.type !== 'image') return;
  const before = clone(state.annots);
  const M = imageViewMatrix(page, a);
  const centre = applyM(M, 0.5, 0.5);
  const r = page.canvas.getBoundingClientRect();
  const sx = page.viewport.width / r.width, sy = page.viewport.height / r.height;
  const angleAt = (cx, cy) => Math.atan2(
    (cy - r.top) * sy - centre[1], (cx - r.left) * sx - centre[0]) * 180 / Math.PI;

  const startAngle = angleAt(e.clientX, e.clientY);
  const startRotation = a.rotation || 0;

  capture(page, (ev) => {
    let next = startRotation + (angleAt(ev.clientX, ev.clientY) - startAngle);
    if (ev.shiftKey) next = Math.round(next / 15) * 15;
    a.rotation = ((next % 360) + 360) % 360;
    drawPage(page);
    setStatus();
  }, () => {
    const after = clone(state.annots);
    state.annots = before;
    snapshot();
    state.annots = after;
    redrawAll();
  });
}

/** Quarter-turn the selected image, the way Preview rotates a page. */
function rotateSelected(deltaDeg) {
  const a = state.annots.find((x) => x.id === state.selectedId);
  if (!a || a.type !== 'image') {
    return toast('Select a pasted image first, then rotate it.');
  }
  snapshot();
  a.rotation = ((((a.rotation || 0) + deltaDeg) % 360) + 360) % 360;
  redrawAll();
  toast(`Image rotated to ${Math.round(a.rotation)}°`);
}

// ------------------------------------------------------- text markup (select)

/**
 * A text markup band runs from the font's descent to its ascent about the
 * baseline -- which is exactly what PDFKit uses, verified on two documents:
 *
 *   attention.pdf  Times   font ascent 0.685 / descent -0.218
 *                          PDFKit band 368.86..377.86, baseline 371.035
 *   lecture deck   sans    font ascent 0.770 / descent -0.230
 *                          PDFKit band  18.75.. 42.75, baseline  24.270
 *
 * Both match the font metrics exactly, so the ratios are per-font, not
 * constants. pdf.js hands them over in textContent.styles. These fallbacks are
 * only for text whose font reports nothing.
 */
const BAND_BELOW_BASELINE = 0.218;
const BAND_ABOVE_BASELINE = 0.685;

// A few fonts declare a bounding box rather than typographic metrics (ascent
// over 1em, descent past -0.4em). Left alone those produce bands that swallow
// the lines above and below, so cap them at something a reader would accept.
const MAX_ASCENT = 1.0;
const MIN_DESCENT = -0.35;

/**
 * Replace a band's browser-derived height with one built from the PDF's own
 * text metrics, so the band hugs the glyphs exactly the way Preview's does.
 * Falls back to the original band for pages with no extractable text.
 */
function snapBandToText(page, band) {
  if (!page || !page.textItems || !page.textItems.length) return band;
  const hits = page.textItems.filter((i) =>
    i.baseline > band.y0 - 0.5 && i.baseline < band.y1 + 0.5 &&
    i.x1 > band.x0 - 1 && i.x0 < band.x1 + 1);
  if (!hits.length) return band;

  const mid = (xs) => {
    const v = xs.slice().sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const size = mid(hits.map((i) => i.size));
  const baseline = mid(hits.map((i) => i.baseline));

  const ascents = hits.map((i) => i.ascent).filter(Number.isFinite);
  const descents = hits.map((i) => i.descent).filter(Number.isFinite);
  const ascent = ascents.length
    ? Math.min(MAX_ASCENT, mid(ascents)) : BAND_ABOVE_BASELINE;
  const descent = descents.length
    ? Math.max(MIN_DESCENT, mid(descents)) : -BAND_BELOW_BASELINE;

  return {
    x0: band.x0, x1: band.x1,
    y0: baseline + size * descent,
    y1: baseline + size * ascent,
  };
}

/**
 * Tidy raw selection rectangles into one clean band per text line.
 *
 * The browser hands back one rectangle per text run, so a single highlighted
 * line can arrive as a dozen slightly mismatched boxes. Drawn as-is they show
 * seams and ragged top edges, and any overlap darkens twice under Multiply.
 * Preview paints one even band per line, so that is what we build: group the
 * boxes into lines, level each line to a common top and bottom, and merge
 * neighbours that touch.
 */
function tidyBands(boxes) {
  if (!boxes.length) return [];

  const median = (xs) => {
    const v = xs.slice().sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  // A selection often picks up stray zero-height or line-break rectangles.
  // Left in, one of them stretches a whole band; drop them.
  const typical = median(boxes.map((b) => b.y1 - b.y0));
  let usable = boxes.filter((b) => b.y1 - b.y0 >= typical * 0.45);
  if (!usable.length) usable = boxes;

  const lines = [];
  for (const b of usable.slice().sort((p, q) => (q.y0 + q.y1) - (p.y0 + p.y1))) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y1, b.y1) - Math.max(l.y0, b.y0);
      return overlap > 0.5 * Math.min(l.y1 - l.y0, b.y1 - b.y0);
    });
    if (line) {
      line.items.push(b);
      // Level to the median, not the extremes: a single tall rectangle on the
      // line must not make the whole band taller than the text.
      line.y0 = median(line.items.map((i) => i.y0));
      line.y1 = median(line.items.map((i) => i.y1));
    } else {
      lines.push({ y0: b.y0, y1: b.y1, items: [b] });
    }
  }

  // Keep neighbouring lines from touching, so bands stay visually separate.
  lines.sort((a, b) => b.y1 - a.y1);
  for (let i = 1; i < lines.length; i++) {
    const above = lines[i - 1], below = lines[i];
    if (below.y1 > above.y0) {
      const mid = (below.y1 + above.y0) / 2;
      above.y0 = mid;
      below.y1 = mid;
    }
  }

  const out = [];
  for (const line of lines) {
    const runs = line.items.slice().sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const r of runs) {
      // 1.5pt closes the hairline seams between adjacent text runs without
      // bridging a genuine gap such as a column break.
      if (cur && r.x0 <= cur.x1 + 1.5) cur.x1 = Math.max(cur.x1, r.x1);
      else { cur = { x0: r.x0, x1: r.x1 }; out.push(cur); }
      cur.y0 = line.y0; cur.y1 = line.y1;
    }
  }
  return out.filter((r) => r.x1 - r.x0 > 0.5 && r.y1 - r.y0 > 0.5);
}

function quadsFromSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

  const raw = new Map();
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const rect of sel.getRangeAt(i).getClientRects()) {
      if (rect.width < 0.6 || rect.height < 0.6) continue;
      const page = pageAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!page) continue;
      const [x0, y0] = toPdf(page, rect.left, rect.bottom);
      const [x1, y1] = toPdf(page, rect.right, rect.top);
      if (!raw.has(page.index)) raw.set(page.index, []);
      raw.get(page.index).push({
        x0: Math.min(x0, x1), x1: Math.max(x0, x1),
        y0: Math.min(y0, y1), y1: Math.max(y0, y1),
      });
    }
  }

  const byPage = new Map();
  for (const [pageIndex, boxes] of raw) {
    const page = state.pages[pageIndex];
    const bands = tidyBands(boxes).map((b) => snapBandToText(page, b));
    if (!bands.length) continue;
    // /QuadPoints order: upper-left, upper-right, lower-left, lower-right.
    byPage.set(pageIndex, bands.map((r) =>
      [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0]));
  }
  return byPage.size ? byPage : null;
}

function applyTextMarkup() {
  if (!TEXT_MARKUP.has(state.tool)) return;
  const byPage = quadsFromSelection();
  if (!byPage) return;

  snapshot();
  let text = window.getSelection().toString().trim();
  if (text.length > 240) text = text.slice(0, 237) + '…';
  for (const [pageIndex, quads] of byPage) {
    state.annots.push({
      id: uid(), page: pageIndex, type: state.tool,
      color: toolColor(), opacity: 1,
      quads, contents: text,
    });
  }
  window.getSelection().removeAllRanges();
  redrawAll();
}

document.addEventListener('mouseup', () => setTimeout(applyTextMarkup, 0));

// ------------------------------------------------------------- text editing

/** Re-wrap a text box and grow it to fit what was typed. */
/** Re-wrap a text box to its current width and size it to exactly fit. Keeps
 *  the top edge where it is, so the box grows and shrinks downward. */
function reflowTextBox(a) {
  a.lines = wrapText(a.text || '', a.fontSize || 14, Math.max(4, a.rect.w - 4));
  const needed = a.lines.length * (a.fontSize || 14) * 1.2 + 6;
  const top = a.rect.y + a.rect.h;          // PDF y is up: this is the top edge
  a.rect.h = needed;
  a.rect.y = top - needed;
}

/** Switch tools without the "insert one immediately" behaviour. */
function setToolQuiet(id) {
  state.tool = id;
  applyToolMode();
  refreshSwatches();
}

let editor = null;

const caretToEnd = (ta) => {
  const end = ta.value.length;
  try { ta.setSelectionRange(end, end); } catch { /* not focusable yet */ }
};

function openEditor(page, a, isNew = false) {
  commitEditor();
  const ta = document.createElement('textarea');
  ta.className = 'ftEditor';
  ta.value = a.text || '';

  const b = viewBox(page, a);
  if (a.type === 'freetext') {
    ta.style.left = `${b.x}px`;
    ta.style.top = `${b.y}px`;
    ta.style.width = `${Math.max(60, b.w)}px`;
    ta.style.height = `${Math.max(24, b.h)}px`;
    ta.style.fontSize = `${(a.fontSize || 14) * state.scale}px`;
    ta.style.color = css(a.color);
    ta.placeholder = 'Text';
  } else {
    ta.style.left = `${b.x + b.w + 6}px`;
    ta.style.top = `${b.y}px`;
    ta.style.width = '220px';
    ta.style.height = '90px';
    ta.style.fontSize = '13px';
    ta.placeholder = 'Type your note…';
  }
  page.el.appendChild(ta);
  editor = { ta, a, page, isNew };
  drawPage(page);                   // hide the painted copy behind the editor
  // Grow with what is typed, the way Preview's text box does. Without this the
  // field keeps its starting height, scrolls, and hides the earlier lines.
  const grow = () => {
    ta.style.height = 'auto';
    // border-box sizing: scrollHeight excludes the border, so add it back or
    // the field ends up a pixel or two short and still scrolls.
    const chrome = ta.offsetHeight - ta.clientHeight;
    const px = Math.max(ta.scrollHeight + chrome,
      Math.round((a.fontSize || 14) * 1.2 * state.scale) + chrome);
    ta.style.height = `${px}px`;
    const neededPt = px / (state.scale || 1);
    if (neededPt > a.rect.h + 0.5) {
      a.rect.y -= (neededPt - a.rect.h);      // keep the top edge where it is
      a.rect.h = neededPt;
    }
  };
  ta.addEventListener('input', grow);
  grow();

  const place = () => { if (isNew) ta.select(); else caretToEnd(ta); };
  ta.focus();
  place();

  // The click that opened this editor can still be settling, so try once more
  // on the next frame. One retry, not a loop that keeps grabbing focus back.
  requestAnimationFrame(() => {
    if (editor && editor.ta === ta && document.activeElement !== ta) {
      ta.focus();
      place();
    }
  });
  // Select-all on a brand new box (so the placeholder is replaced), but put the
  // caret at the end when editing existing text -- otherwise one keystroke
  // wipes what is already there.
  if (isNew) ta.select();
  else ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); commitEditor(); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commitEditor(); }
  });
  // Deliberately NOT committing on blur. Focus is lost transiently all the
  // time on macOS -- including in the instant after the click that opened this
  // editor -- and committing then closes the box the moment you open it.
  // Clicks outside, Escape, picking another tool and saving all commit instead.
}

function commitEditor() {
  if (!editor) return;
  const { ta, a, isNew } = editor;
  const stale = !state.pages.includes(editor.page);
  const value = ta.value;
  editor = null;
  ta.remove();
  // The page it belonged to is gone (document closed): drop it rather than
  // writing into the document that replaced it.
  if (stale) return;

  // Finishing with a text box lets go of it completely: no editor, no
  // selection outline. Getting back in is a double-click.
  // Finishing a box you actually wrote in means you are done: drop back to the
  // arrow. Discarding the empty placeholder does NOT count as finishing -- the
  // click that discarded it is usually the click placing the real box, and
  // switching tools here would swallow it.
  let finished = true;

  if (!value.trim() && isNew) {
    state.annots = state.annots.filter((x) => x.id !== a.id);
    if (state.undo.length) state.undo.pop();      // drop the empty create
    finished = false;
  } else if (isNew) {
    a.text = value;
    if (a.type === 'freetext') reflowTextBox(a);
    markChanged();
  } else if (value !== (a.text || '')) {
    const before = clone(state.annots);
    a.text = value;
    if (a.type === 'freetext') reflowTextBox(a);
    const after = clone(state.annots);
    state.annots = before;
    snapshot();
    state.annots = after;
  }

  state.selectedId = null;
  if (finished && state.tool === 'freetext') setToolQuiet('select');
  redrawAll();
}

// -------------------------------------------------------------- image paste

/**
 * ⌘V: paste whatever is on the clipboard. An image becomes a stamp you can
 * move, resize and rotate; text becomes a text box.
 */
async function pasteClipboard() {
  if (!state.doc) return toast('Open a PDF first.', true);
  const r = await window.api.readClipboardImage();
  if (!r.ok) return toast(r.reason || 'Nothing on the clipboard to paste.', true);
  return r.kind === 'text' ? pasteText(r.text) : pasteImage(r);
}

/** Drop clipboard text onto the page as a text box, sized to what it needs. */
function pasteText(text) {
  const page = currentPage();
  if (!page) return;
  const pv = page.pdfPage.getViewport({ scale: 1 });
  const fontSize = defaultFontSize(page);
  const width = Math.min(pv.width * 0.55, defaultTextWidth(page) * 1.3);
  const lines = wrapText(text, fontSize, width - 4);
  const height = Math.max(fontSize * 1.2, lines.length * fontSize * 1.2) + 6;

  const [cx, cy] = viewCentreInPdf(page);
  snapshot();
  const a = {
    id: uid(), page: page.index, type: 'freetext',
    color: toolColor('freetext'), fontSize,
    rect: { x: cx - width / 2, y: cy - height / 2, w: width, h: height },
    text, lines,
  };
  state.annots.push(a);
  state.selectedId = a.id;
  setTool('select');
  redrawAll();
  const preview = text.replace(/\s+/g, ' ').trim();
  toast(`Pasted text: "${preview.slice(0, 40)}${preview.length > 40 ? '…' : ''}"`);
}

/** The middle of whatever part of the page is on screen, in PDF points. */
function viewCentreInPdf(page) {
  const vr = $('#viewer').getBoundingClientRect();
  const pr = page.el.getBoundingClientRect();
  const cx = Math.max(pr.left, Math.min(pr.right, (vr.left + vr.right) / 2));
  const cy = Math.max(pr.top, Math.min(pr.bottom, (vr.top + vr.bottom) / 2));
  return toPdf(page, cx, cy);
}

async function pasteImage(r) {
  if (!r) {
    if (!state.doc) return toast('Open a PDF first.', true);
    r = await window.api.readClipboardImage();
    if (!r.ok) return toast(r.reason || 'No image on the clipboard.', true);
    if (r.kind === 'text') return pasteText(r.text);
  }

  const page = currentPage();
  if (!page) return;

  const id = uid();
  state.images[id] = r.data;

  // Place at 96 dpi -> 72 pt, capped at half the page so it always lands visibly.
  const pv = page.pdfPage.getViewport({ scale: 1 });
  const aspect = r.height / r.width;
  let w = Math.min(r.width * 0.75, pv.width * 0.5);
  let h = w * aspect;
  if (h > pv.height * 0.5) { h = pv.height * 0.5; w = h / aspect; }

  const [px, py] = viewCentreInPdf(page);

  snapshot();
  const a = {
    id: uid(), page: page.index, type: 'image', imageId: id,
    rect: { x: px - w / 2, y: py - h / 2, w, h },
  };
  state.annots.push(a);
  state.selectedId = a.id;
  setTool('select');
  redrawAll();
  toast(`Pasted ${r.width}×${r.height} image${r.origin.startsWith('file:') ? ` (${r.origin.slice(5)})` : ''}`);
}

// --------------------------------------------------------------------- save

async function save(saveAs = false, { quiet = false } = {}) {
  if (!state.doc) { window.api.saveFinished(false); return toast('Open a PDF first.', true); }
  if (state.busy) return;
  commitEditor();
  if (!state.annots.length && !state.dirty && !saveAs) {
    window.api.saveFinished(true);        // nothing to do == nothing pending
    if (!quiet) toast('No changes to save.');
    return;
  }

  state.busy = true;
  try {
    // Only the images actually referenced travel over IPC.
    // Saving must not change what is on screen: an autosave firing while you
    // have placed a box but not yet typed in it would otherwise delete it out
    // from under you. Empty boxes are simply not written (filtered below).
    const used = new Set(state.annots.filter((a) => a.type === 'image').map((a) => a.imageId));
    const images = {};
    for (const k of used) images[k] = state.images[k];

    const r = await window.api.savePdf({
      sourceBytes: state.originalBytes,
      sourcePath: state.path,
      annotations: state.annots.filter(
        (a) => a.type !== 'freetext' || (a.text && a.text.trim())),
      removeAt: state.imported,
      images,
      saveAs,
    });

    if (!r.ok) {
      if (!r.canceled) toast(r.error || 'Save failed.', true);
      // Tell main immediately -- it must not sit waiting for a save that is
      // never going to happen.
      window.api.saveFinished(false);
      return;
    }
    state.path = r.path;
    state.name = r.name;
    state.dirty = false;
    refreshDocName();
    setStatus();
    window.api.saveFinished(true);
    if (!quiet) {
      toast(r.written
        ? `Saved ${r.written} annotation${r.written === 1 ? '' : 's'} to ${r.name}`
        : `Saved ${r.name} with no annotations`);
    }
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------- ui

function buildToolbar() {
  const tools = $('#tools');
  for (const t of TOOLS) {
    if (t.divider) {
      const d = document.createElement('div');
      d.className = 'divider';
      tools.appendChild(d);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.tool = t.id;
    b.title = t.label;
    b.innerHTML = `<svg viewBox="0 0 17 17">${ICONS[t.icon]}</svg>`;
    b.addEventListener('click', () => setTool(t.id));
    tools.appendChild(b);
  }

  buildSwatches();

  const widths = $('#strokeWidths');
  STROKE_STEPS.forEach((step, i) => {
    const b = document.createElement('button');
    b.dataset.stroke = String(i);
    b.title = step.label;
    b.innerHTML = `<span class="bar" style="height:${step.h}px"></span>`;
    b.addEventListener('click', () => {
      state.strokeStep = i;
      applySelectedStyle();
      refreshPanel();
    });
    widths.appendChild(b);
  });

  const sizes = $('#fontSizes');
  FONT_STEPS.forEach((step, i) => {
    const b = document.createElement('button');
    b.dataset.font = String(i);
    b.title = `${step.label} text`;
    b.innerHTML = `<span class="sz">${step.label}</span>`;
    b.addEventListener('click', () => {
      state.fontStep = i;
      applySelectedStyle();
      refreshPanel();
    });
    sizes.appendChild(b);
  });

  for (const b of document.querySelectorAll('[data-zoom]')) {
    b.addEventListener('click', () => zoom(parseInt(b.dataset.zoom, 10)));
  }
  for (const b of document.querySelectorAll('[data-fit]')) {
    b.addEventListener('click', () => applyFit(b.dataset.fit));
  }
  $('#openBtn').addEventListener('click', doOpen);
  $('#openBtn2').addEventListener('click', doOpen);
  $('#undoBtn').addEventListener('click', () => undo());
  $('#redoBtn').addEventListener('click', () => redo());
  applyToolMode();
  refreshPanel();
}

/** The colour row follows the tool: highlighter inks are pale, pens are not. */
function buildSwatches() {
  const colors = $('#colors');
  colors.innerHTML = '';
  const set = TEXT_MARKUP.has(state.tool) ? HIGHLIGHT_PALETTE : PALETTE;
  for (const c of set) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.rgb = c.rgb.join(',');
    b.style.background = css(c.rgb);
    b.title = c.name;
    b.addEventListener('click', () => {
      if (INK_TOOLS.has(state.tool)) state.inkColor = c.rgb.slice();
      else state.markupColor = c.rgb.slice();
      const a = state.annots.find((x) => x.id === state.selectedId);
      if (a && a.color) { snapshot(); a.color = c.rgb.slice(); redrawAll(); }
      refreshPanel();
    });
    colors.appendChild(b);
  }
}

/** Push the current stroke/size choice onto whatever is selected. */
function applySelectedStyle() {
  const a = state.annots.find((x) => x.id === state.selectedId);
  if (!a) return;
  const page = state.pages[a.page];
  if (!page) return;
  snapshot();
  if (a.strokeWidth != null) a.strokeWidth = strokeWidthFor(page);
  if (a.type === 'freetext') {
    a.fontSize = defaultFontSize(page);
    reflowTextBox(a);
  }
  redrawAll();
}

/** Panel contents depend on the tool and on what is selected. */
function refreshPanel() {
  const selected = state.annots.find((x) => x.id === state.selectedId);
  const tool = state.tool;
  const showsColour = tool !== 'select' || !!selected;
  const showsStroke = INK_TOOLS.has(tool) && tool !== 'freetext'
    || (selected && selected.strokeWidth != null);
  const showsFont = tool === 'freetext' || (selected && selected.type === 'freetext');

  $('#panel').classList.toggle('hidden', !state.doc || !showsColour);
  $('#strokeGroup').style.display = showsStroke ? '' : 'none';
  $('#fontGroup').style.display = showsFont ? '' : 'none';

  buildSwatches();
  const current = (selected && selected.color) ? selected.color : toolColor();
  for (const b of document.querySelectorAll('.swatch')) {
    b.classList.toggle('active',
      b.dataset.rgb.split(',').every((v, i) => Math.abs(+v - current[i]) < 0.01));
  }
  for (const b of document.querySelectorAll('[data-stroke]')) {
    b.classList.toggle('active', +b.dataset.stroke === state.strokeStep);
  }
  for (const b of document.querySelectorAll('[data-font]')) {
    b.classList.toggle('active', +b.dataset.font === state.fontStep);
  }
}

const refreshSwatches = refreshPanel;

function zoom(dir) {
  if (dir === 'actual') return reflow(1, 'manual');
  if (dir === 0) return applyFit('fit');
  const steps = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4];
  const i = steps.findIndex((s) => s >= state.scale - 0.001);
  const next = dir > 0
    ? steps[Math.min(steps.length - 1, i < 0 ? steps.length - 1 : i + 1)]
    : steps[Math.max(0, (i < 0 ? steps.length : i) - 1)];
  reflow(next, 'manual');
}

async function doOpen(pathOrEvent) {
  const p = typeof pathOrEvent === 'string' ? pathOrEvent : undefined;
  // The prompt lives in the main process so it is a real macOS sheet, and so
  // "Save…" can actually run the save before the document is replaced.
  if (state.dirty && !(await window.api.confirmDiscard())) return;
  openDocument(await window.api.openPdf(p));
}

/** Text boxes that were placed but never written in are not content. */
function dropEmptyTextBoxes() {
  const before = state.annots.length;
  state.annots = state.annots.filter(
    (a) => a.type !== 'freetext' || (a.text && a.text.trim()) || a.id === state.selectedId);
  if (state.annots.length !== before) setStatus();
}

function deleteSelected() {
  if (!state.selectedId) return;
  snapshot();
  state.annots = state.annots.filter((a) => a.id !== state.selectedId);
  state.selectedId = null;
  redrawAll();
}

// -------------------------------------------------------------- menu + keys

window.api.onMenu(async (action, arg) => {
  // onMenu strips the "menu:" prefix; other channels arrive whole.
  switch (action) {
    case 'open':     return doOpen();
    case 'openPath': return doOpen(arg);
    case 'save':     return save(false);
    case 'saveAs':   return save(true);
    case 'undo':     return undo();
    case 'redo':     return redo();
    case 'paste': {
      // Editing a text box? Then ⌘V means what it always means.
      const el = document.activeElement;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
        return window.api.pasteIntoField();
      }
      return pasteClipboard();
    }
    case 'delete':   return deleteSelected();
    case 'tool':     return setTool(arg);
    case 'rotate':   return rotateSelected(arg);
    case 'zoom':     return zoom(arg);
    case 'fit':      return applyFit(arg);
    case 'fullscreen':
      document.documentElement.dataset.fullscreen = arg ? 'true' : 'false';
      return;
  }
});

window.addEventListener('keydown', (e) => {
  // A text box is open: it owns the keyboard. Escape finishes; everything else
  // is typing and belongs to the field, so this handler stays out of the way.
  if (editor) {
    if (e.key === 'Escape') { e.preventDefault(); commitEditor(); }
    return;
  }
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  // Ctrl+Z / Ctrl+Shift+Z as well as the Cmd equivalents.
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (e.key === 'Escape') {
    if (state.selectedId) {
      state.selectedId = null; dropEmptyTextBoxes(); redrawAll();
    } else setTool('select');
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedId) {
    e.preventDefault();
    deleteSelected();
  }
});

// Keep the fit honest when the window changes size.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.doc || state.zoomMode === 'manual') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => applyFit(), 160);
});

$('#viewer').addEventListener('scroll', () => {
  if (!state.pages.length) return;
  if (updatePageIndicator.queued) return;
  updatePageIndicator.queued = true;
  requestAnimationFrame(() => {
    updatePageIndicator.queued = false;
    updatePageIndicator();
  });
});

/**
 * Commit the open text box on any click that lands outside it.
 *
 * Relying on the textarea's own blur is not enough: macOS does not focus a
 * button when you click it, so clicking the toolbar left the editor open and
 * the text uncommitted. Capture-phase so this runs before anything else.
 */
document.addEventListener('pointerdown', (e) => {
  if (editor && e.target !== editor.ta && !editor.ta.contains(e.target)) {
    commitEditor();
  }
  // Same for the document name: a click anywhere else commits the rename.
  const nameField = $('#docName');
  if (nameField && document.activeElement === nameField && e.target !== nameField) {
    commitDocName();
  }
}, true);

// Switching apps leaves the editor open with your text in it; it is committed
// when you come back and click, or press Escape. Committing on window blur
// would also fire on incidental focus changes.

// Clicking the empty space around a page deselects, as on any canvas.
$('#viewer').addEventListener('pointerdown', (e) => {
  if (e.target !== $('#viewer') && e.target !== $('#pages')) return;
  if (state.selectedId) {
    state.selectedId = null;
    dropEmptyTextBoxes();
    redrawAll();
  }
});

// ------------------------------------------------------------ document name

/** Show the open file's name, and let it be renamed in place. */
function refreshDocName() {
  const island = $('#titleIsland');
  const input = $('#docName');
  if (!island || !input) return;
  island.classList.toggle('hidden', !state.doc);
  if (!state.name) return;
  if (document.activeElement !== input) {
    input.value = state.name.replace(/\.pdf$/i, '');
    input.size = Math.max(8, Math.min(40, input.value.length + 1));
  }
}

let renaming = false;
async function commitDocName() {
  const input = $('#docName');
  if (!input || !state.path || renaming) return;
  const wanted = input.value.trim();
  const current = state.name.replace(/\.pdf$/i, '');
  if (!wanted || wanted === current) { refreshDocName(); return; }
  renaming = true;

  // Let any pending autosave land first, so the rename does not race it.
  if (state.dirty) await save(false, { quiet: true });

  try {
    const r = await window.api.renameDoc(state.path, wanted);
    if (!r.ok) {
      toast(r.error || 'Could not rename the file.', true);
      refreshDocName();
      return;
    }
    state.path = r.path;
    state.name = r.name;
    refreshDocName();
    setStatus();
    toast(`Renamed to ${r.name}`);
  } finally {
    renaming = false;
  }
}

$('#docName').addEventListener('keydown', (e) => {
  e.stopPropagation();                       // never let a tool shortcut fire
  if (e.key === 'Enter') {
    e.preventDefault();
    // Commit directly. Going through blur() is unreliable: the element can
    // hold activeElement without the platform delivering a blur, which is the
    // same trap that broke committing a text box.
    commitDocName();
    $('#docName').blur();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    // Put the old name back *before* blurring. refreshDocName() deliberately
    // leaves a focused field alone, so without this the blur handler would
    // commit the abandoned name.
    const input = $('#docName');
    input.value = (state.name || '').replace(/\.pdf$/i, '');
    input.blur();
    refreshDocName();
  }
});

// Blur is a bonus path, not the mechanism.
$('#docName').addEventListener('blur', () => { commitDocName(); });
$('#docName').addEventListener('input', () => {
  const input = $('#docName');
  input.size = Math.max(8, Math.min(40, input.value.length + 1));
});

// ---------------------------------------------------------------- theming

/** Resolve the theme once and write it out explicitly, so the CSS never has to
 *  guess. Follows the system until you choose, then remembers your choice. */
function applyTheme(theme) {
  const resolved = theme === 'dark' || theme === 'light' ? theme
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = resolved;
  state.theme = resolved;
  const btn = $('#themeBtn');
  if (btn) btn.title = resolved === 'dark' ? 'Switch to light' : 'Switch to dark';
}

function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch { /* not critical */ }
  applyTheme(next);
}

(() => {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* ignore */ }
  applyTheme(saved);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    let chosen = null;
    try { chosen = localStorage.getItem('theme'); } catch { /* ignore */ }
    if (!chosen) applyTheme(null);            // still following the system
  });
})();

$('#themeBtn').addEventListener('click', toggleTheme);

buildToolbar();
setStatus();

// Exposed for the automated UI test, which drives the real code paths rather
// than synthesising clicks.
window.__app = {
  state, setTool, pasteImage, pasteClipboard, pasteText, save, undo, redo, redrawAll, snapshot,
  openDocument, deleteSelected, quadsFromSelection, applyTextMarkup, wrapText, toPdf, toView,
  rotateSelected, imageCorners, imageViewMatrix, imageMatrix, applyM, viewBox, tidyBands, snapBandToText,
  importExistingMarks, markFromExisting,
  renderPageContent, ensurePageRendered, applyFit, fitScale, reflow, zoom,
  scrollAnchor, updatePageIndicator, annotBounds, pageLimits, pdfToClient,
  docScale, defaultFontSize, toolColor, createTextual, openEditor, commitEditor,
  applyTheme, toggleTheme, refreshPanel, dropEmptyTextBoxes, annotationAt,
  refreshDocName, commitDocName,
  pageAt, currentPage, uid,
};
