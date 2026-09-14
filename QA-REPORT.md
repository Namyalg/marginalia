# QA Report — PDF Annotator

> **Note on the repro commands below.** The ad-hoc `test/qa/*.js` scripts this
> report was written against have been removed: they hardcoded absolute paths
> into one machine and pointed at a private document. Every finding here is now
> covered by the permanent suites — `npm test`, `npm run test:ui`,
> `npm run test:functions`, `npm run test:reopen` — so the `test/qa/…` commands
> are kept only as a record of how each bug was originally reproduced.


Independent PM/QA pass, 2026-09-12.

**Caveat on what I tested**: the source changed under me mid-session. Versions
exercised: `renderer/app.js` `19:49` (the font-metrics band fix **is** present —
see defect 5), `lib/pdf-writer.js` `19:09`, `main.js` `19:45`, `preload.js`
`19:45`+. After my last run, `preload.js` gained `pasteIntoField` / `edit:paste`
and the README began advertising a paste path I never exercised — clipboard
**text** becoming a text box, and ⌘V pasting inline inside a text box. That
feature is untested here. Everything below refers to the versions above.

Environment: macOS 14.4, Electron 44.3.0, PyObjC/PDFKit and `qlmanage`
available. Harness scripts referenced below are in
`test/qa/qa1.js` … `qa6.js`.

---

## Verdict

**Not ready for daily use as it stands, but it is close — two defects do real
damage and both are narrow.** The core is genuinely good: annotating page 40 of
a 72-page landscape deck at 200% zoom writes a `/Highlight` to page 39 with a
`/Rect` matching the on-screen quad to within the writer's deliberate 1 pt pad,
pre-existing markup in that deck survives untouched, CropBox-offset pages are
correct, and paragraph highlights on body text come out as one even band per
line with no seams and no double-darkening. But **every text markup and shape
written to a `/Rotate 90` or `/Rotate 270` page lands somewhere else entirely in
the saved file while looking perfect on screen** — CoreGraphics puts our band
at x 9–17% of the page where Preview's own is at x 91–92%. That is the exact
failure mode you asked me to hunt for, and the shipped suite structurally cannot
see it: the two rotation checks compare `toPdf()`'s output against `toPdf()`'s
output, so they pass regardless of which frame it returns. Second, the dirty flag
and `save()` disagree about what an empty document means, so the ordinary
sequence *draw → ⌘Z → ⌘W* ends with the app quietly refusing to close. Fix those
two and the note/stroke-width issues below, and I'd use it.

---

## Blocking defects

### 1. Text markup and shapes land in the wrong place on `/Rotate 90` / `/Rotate 270` pages — severity: critical, silent wrong output

The renderer draws the mark correctly on screen (it inverts the same viewport
transform it created it with), so nothing looks wrong. The bytes written are
wrong.

**Repro** — `npx electron test/qa/qa4.js`. For each fixture it (a) has PDFKit
highlight the phrase "Page 1" — the reference Preview itself would draw — (b)
highlights the same span through the app's own selection path, (c) rasterises
both with `qlmanage -t -s 1000` and reports where the yellow ink actually is.

```
=== rotated90 ===            (/Rotate = 90)
  our quad:            [54.17,135.35, 77.13,135.35, 54.17,71.97, 77.13,71.97]
  PDFKit ref /Rect :   [[72, 723.32, 63.38, 7.79]]
  our      /Rect :     [[53.17, 70.97, 24.96, 65.38]]
  CoreGraphics yellow, PDFKit ref: x 91.4-92.1%  y 11.7-21.9%   (424 px)
  CoreGraphics yellow, ours      : x  9.1-17.0%  y  8.7-12.4%  (2400 px)
  boxes overlap: NO -- different place on the page

=== rotated270 ===           (/Rotate = 270)
  PDFKit ref /Rect :   [[72, 723.32, 63.38, 7.79]]
  our      /Rect :     [[533.87, 655.65, 24.96, 65.38]]
  CoreGraphics yellow, PDFKit ref: x  7.8-8.5%   y 77.8-88.1%
  CoreGraphics yellow, ours      : x  9.1-17.0%  y  8.7-12.4%
  boxes overlap: NO -- different place on the page
```

**Observed**: on a `/Rotate 90` page the highlight paints at the top-left,
horizontally, over blank paper. **Expected**: over the text, at the right edge,
vertically — where PDFKit puts it. The control cases in the same run prove the
harness is sound: `plain` and `cropoffset` both come back `boxes overlap: YES`
with our ink at x 11.8–22.0% against PDFKit's x 11.8–22.0% (and 3.5–13.9% vs
3.6–13.9% for cropoffset, which also confirms the CropBox origin handling is
right).

**Root cause**: `toPdf()` in `renderer/app.js` trusts
`viewport.convertToPdfPoint()` to "invert rotation and CropBox offset for us"
(the comment says exactly this). It inverts the CropBox offset — cropoffset
passes — but the point it returns for a rotated page is in the *rotated* frame,
not the unrotated user space that `/Rect` and `/QuadPoints` are defined in. The
writer then stores that rotated-frame quad verbatim, and every downstream viewer
applies `/Rotate` to it a second time. Note the shape is transposed too — our
saved rect is 24.96 × 65.38 where PDFKit's is 63.38 × 7.79 — which is the
signature of a 90° frame error, not an offset error.

**It looks perfect on screen** — that is what makes this the dangerous kind of
bug. `qa5.js` section E2 measures the on-screen band against the very text span
it was made from, on the same `/Rotate 90` page:

```
  on-screen band : {"x":81.5,"y":61.3,"w":71.8,"h":26}
  the text span  : {"x":81.5,"y":63.3,"w":71.8,"h":22.6}
  overlap on screen: YES (71.8x22.6)
```

Identical x and width, full overlap. The user has no signal at all that the file
is wrong until they open it in Preview.

Every tool routes its creation point through the same `toPdf()`, so highlight,
underline, strikeout, rectangle, oval, line, arrow, sketch, text box, note and
image placement all sit on the broken path. I proved the wrong output
end-to-end for **text markup**; I did not get a clean raster discriminator for a
pasted image, because the paste lands at page centre, where a 90° frame error is
largely self-cancelling. Treat the fix as one shared coordinate fix rather than a
text-markup fix.

**Why the suite missed it**, two layers:

- `npm test` asserts `rotated90.pdf: CoreGraphics renders the annotations --
  5.1% of pixels changed`. Ink appearing *anywhere* on the page satisfies that.
- `test/ui-test.js:696` asserts `highlight aligned to the text within 2pt`, but
  builds its "expected" box by calling `A.toPdf()` on the span's client rect and
  compares it to a quad also built by `A.toPdf()`. It is `toPdf` checked against
  `toPdf` — see the claims section. Same for the `within 0.6px` round-trip
  immediately above it (`toPdf` → `toView` → back).

The discriminating assertion is the one in `qa4.js`: create the reference with
PDFKit, rasterise both with CoreGraphics, and require the painted boxes to
overlap. I'd add that to the suite for all four fixtures.

---

### 2. `draw → undo → close` silently declines to close, 30 s after you ask it to — severity: high, interaction dead-end

**Repro (renderer half, reproduced)** — `npx electron test/qa/qa1.js`:

```
=== A2. dirty flag after annots go to zero ===
  dirty after draw: true | after delete: {"dirty":true,"n":0}
  Cmd-S toast: "No annotations to save." | dirty still: true

=== A3. undo back to a clean document ===
  after undo: annots = 0 , dirty = true
```

**Observed**: with zero annotations and `state.dirty === true`, `save()`
short-circuits at `renderer/app.js`:

```js
if (!state.annots.length && !saveAs) return toast('No annotations to save.');
```

so `state.dirty` is never cleared and nothing is written.

**Expected**: either the save proceeds (writing original-bytes + zero
annotations, which is a legitimate "revert my markup" save), or `state.dirty` is
cleared because the document now matches disk.

**The user-visible consequence** is in `main.js`. The window `close` handler
does `send('menu:save'); const saved = await waitForClean(); if (!saved) return;`
and `waitForClean` polls (`setTimeout(tick, 120)`) for a full **30 000 ms**
before giving up. So: draw a rectangle, press ⌘Z, press ⌘W, choose "Save…" → the
close sheet dismisses and nothing happens. Thirty seconds later the window is
still there and will stay there. To be precise about severity: the poll is async,
so the window remains fully responsive throughout — this is not a beachball, it
is a close request that is silently dropped. The only explanation offered is a
2.4-second toast reading "No annotations to save," long gone by the time the user
realises the window did not close. The same 30-second dead period follows any
save the user cancels from the Save-As sheet, and any save that errors.

Two independent bugs stacked: `undo()` and `deleteSelected()` unconditionally
set `dirty = true` even when returning the document to its saved state, and
`waitForClean` treats "the renderer declined to save" as "wait longer".

---

## Non-blocking defects

### 3. A note is drawn at twice its saved height and offset by half of it

Category 1 again — looks fine, saves differently.

**Repro** — `test/qa/qa1.js` section A1, note placed at PDF (100, 400):

```
  a.rect (what gets saved):  {"x":100,"y":400,"w":20,"h":20}
  on-screen box in PDF pts:  x 100.00 -> 120.00   y 380.00 -> 420.00
  screen w x h (pdf pts):    20.00 x 40.00
  PDFKit /Rect for the note: [["Text",[100, 376, 24, 24]]]
```

**Observed**: the icon on screen occupies y 380→420 (40 pt tall). The writer
emits `Rect: [x, y - s, x + s, y]` = y 380→400 (`lib/pdf-writer.js`, `case
'note'`), and PDFKit reads the placed note back at y 376→400. The top half of
what you see is not in the file, and the saved note's centre sits 12 pt below
the drawn one.

**Root cause**: `viewBox()` in `renderer/app.js` special-cases notes by pushing
*two extra* corners on top of the rect's own two — `push(x, y-20)` and
`push(x+20, y)` — producing a 20 × 40 union instead of replacing the 20 × 20
rect with the writer's 20 × 20 `[x, y-20, x+20, y]` box. The hit area, selection
outline and popup-editor anchor all inherit the wrong box.

### 4. The stroke-width slider edits your document with no undo entry and no dirty flag

**Repro** — `test/qa/qa1.js` sections A4/A5:

```
=== A4. stroke-width slider ===
  strokeWidth now 8 | dirty = false | undo depth = 0
=== A5. colour swatch (same shape, for contrast) ===
  colour now [0.3,0.62,0.98] | dirty = true | undo depth = 1
```

**Observed**: select a saved rectangle, drag the stroke slider, close the
window. No unsaved-changes sheet appears and the change is gone. **Expected**:
the colour swatch handler right above it does the right thing (`snapshot()` then
mutate); the `#strokeRange` `input` handler mutates `a.strokeWidth` directly with
neither. ⌘Z after a width change also undoes the *previous* action instead.

### 5. The font-metrics band fix — checked on a third typeface, and it holds

*(Not a defect. Recording it because you asked me to tell you if the fix was
still wrong on fonts I tried.)*

Your note said to re-pull before testing this. There is no git repo here
(`git log` returns nothing, no `.git`), so there was nothing to pull — but the
fix landed on disk mid-session and I tested the version that arrived:
`snapBandToText()` now reads `ascent`/`descent` from `textContent.styles`, with
the 0.218/0.685 pair demoted to a fallback and capped at `MAX_ASCENT 1.0` /
`MIN_DESCENT -0.35`.

**Repro** — `npx electron test/qa/qa6.js`. To make the comparison sound I
first found a phrase that PDFKit's `findString` matches on **page index 39 and
nowhere else** in the deck, so the reference and our highlight are provably the
same line. Font is the deck's monospace face, size 31, published `ascent
0.92822 / descent -0.23584` — a third typeface, and one whose ascent is nowhere
near the fitted 0.685 constant:

```
phrase (unique to page index 39): "(0.20006773436081007, 0.8932440732695813)"
PDFKit page index 39  band y 139.38 -> 175.46
ours    page index 39  band y 139.38 -> 175.47
delta: bottom 0.00 pt, top 0.01 pt, left -0.03 pt
PDFKit implied ascent  0.9279 vs font 0.92822265625
PDFKit implied descent -0.2359 vs font -0.23583984375
```

**The fix is correct on this font**: top and bottom within 0.01 pt, and PDFKit's
own band reproduces the font's published metrics to four decimal places. The old
fixed constants would have been 7.6 pt short at the top here. Your §4
generalisation survives a third typeface.

One caution about my own earlier measurement, in case you see it elsewhere:
`qa2.js` section B2 showed a 3.00 pt top delta on a 45 pt sans line. That
comparison is **void** — PDFKit matched the phrase on page index 37 while our
highlight was on page 39 (slide build-up duplicates), so it was measuring two
different lines. Ignore it; qa6 is the sound version.

Band *quality* on body text is also good — `qa3.js` section C3, paragraph
selection across `attention.pdf` page 3:

```
  {"n":7, "heights":[8.85,8.91,8.88,8.96], "overlaps":0,
   "gaps":[2.23,2.01,14.14,2.08,2.01]}
```

Seven bands, heights within 0.11 pt of each other, zero overlapping bands (so no
double-darkening under Multiply), even 2 pt gaps between lines and one 14 pt gap
at the paragraph break. That part is solid.

### 6. An annotation dragged off the page vanishes, is unrecoverable, and is still written to the file

**Repro** — `test/qa/qa1.js` section A6, rectangle translated past the top of
a 792 pt page:

```
  page height 792.0 pt; rect.y now 1042.0 (off the top of the page)
  viewBox y = -290.4 (overlay height 697.0 -> negative = invisible)
  PDFKit after save: [{"page":0,"type":"Square","rect":[49,1041,102,82], ...}]
```

**Observed**: `beginMove()` clamps nothing and never reassigns `a.page`. Drag a
mark past the page edge and the SVG overlay clips it away. It is still in
`state.annots`, still counted in the status bar, and still written to the saved
PDF at `/Rect` y 1041 on a 792 pt page — where no viewer will ever draw it. Once
you click elsewhere and lose the selection there is no way to get it back: there
is no annotation list, and ⌘Z only helps if it was your last action.
**Expected**: clamp the drag to the page, or move the annotation to the page it
was dropped on (Preview does the latter).

### 7. Saved annotations cannot be edited after reopening the file

The app's own README sells editability, and Preview genuinely gives it to you.
Here, `openDocument()` sets `state.annots = []`, so annotations already in the
file are pdf.js pixels on the canvas and nothing more. Reopen your own work and
you cannot select, move, recolour or delete a single mark you made yesterday —
only add new ones.

**Repro** — `qa5.js` section E3, reopening a file the app had just annotated:

```
  editable annotations after reopen: 0 | status: "rotated90-img.pdf  ·  Page 1 of 2"
```

The status bar does not even report the annotations that are in the document.
This is a usability defect, not data loss: `qa3.js` section C1 confirms the 7
pre-existing `/FreeText` annotations in a 72-page lecture deck survived a save
untouched (`7 before, 7 after`).

---

## Things claimed that are not true

1. **VERIFICATION.md §8 — "No test verifies the PDF writer using the PDF
   writer. Independent engines only."** This is the claim the whole test
   strategy rests on, and the two rotation/crop checks in `test/ui-test.js`
   break it. `test/ui-test.js:696` (`${fixture}: highlight tracks the text`)
   establishes ground truth like this:

   ```js
   const sr = spans[1].getBoundingClientRect();
   const c0 = A.toPdf(page, sr.left, sr.bottom);
   const c1 = A.toPdf(page, sr.right, sr.top);
   ...
   // then asserts hl.quads[0] is within 2pt of that box
   ```

   Both the quad and the "expected" box come out of `A.toPdf()`. The check is
   `toPdf` agreeing with itself, so it passes no matter what frame `toPdf`
   returns — which is precisely why defect 1 has gone unnoticed. The round-trip
   assertion three lines above it (`toPdf` → `toView` → back, "within 0.6px") is
   self-consistent in the same way. Neither involves PDFKit, CoreGraphics or
   pdf.js.

2. **README "Covered: … text selection on normal, `/Rotate 90`, `/Rotate 270`
   and CropBox-offset pages"** — covered in the sense that a test runs, not in
   the sense that the result is correct. Defect 1: `/Rotate 90` and `/Rotate
   270` output lands in the wrong place, proven by CoreGraphics. CropBox-offset
   genuinely is correct.

3. **README "Unsaved work is not lost quietly."** — mostly true, with two holes.
   The stroke-width slider changes the document without setting the dirty flag at
   all (defect 4), so that edit *is* lost quietly. And the close prompt's
   "Save…" branch can sit for 30 s and then silently decline to close (defect 2).

4. **README "Everything is written as real PDF annotation objects, so a file
   saved here opens in Preview with the markup still selectable and editable."**
   True of Preview. Not true of this app reopening its own output — defect 7.
   A reader will assume round-trip editability in both directions.

5. **README keyboard table lists `⌘V paste`** while `main.js` binds `CmdOrCtrl+V`
   to Edit ▸ Paste **and** `CmdOrCtrl+Shift+V` to Tools ▸ Paste Image from
   Clipboard, both firing the same `menu:paste`. Minor, but the table does not
   mention ⇧⌘V at all.

VERIFICATION.md §4's band claim **holds** — see defect 5, where I confirmed it
on a third typeface.

---

## What I tested and found solid

- **Multi-page correctness on the 72-page landscape deck.** Opened
  a 72-page lecture deck (6 MB, 72 pages, 1232 × 693 viewport at Fit 64%) in **284 ms**
  with all 72 pages laid out. Zoomed to 200% (`reflow` 1586 ms), scrolled to page
  40, forced render (111 text items, 148 spans), highlighted a line. Saved and
  read back through PDFKit: the `/Highlight` is on **page index 39**, `/Rect
  [623.38, 630.72, 1017.46, 47]` against an expected `[624.38, 631.72, 1015.46,
  45.00]` — the 1 pt difference on each side is the writer's deliberate pad. Text
  content round-trips verbatim. Status bar tracked to "Page 40 of 72" correctly.
  Lazy rendering did not skip the page.
- **Existing markup preservation.** The deck's 7 `/FreeText` annotations were
  still 7 after a save, alongside the new highlight.
- **CropBox-offset pages at 200% zoom.** Quad x 71.97→135.35 against PDF text
  items x0 72.00 / x1 135.38 — within 0.03 pt. CoreGraphics confirms our ink
  lands at x 3.5–13.9% where PDFKit's lands at 3.6–13.9%.
- **Highlight band quality on body text.** Seven-band paragraph selection on
  `attention.pdf`: uniform heights, no overlaps, clean inter-line gaps (numbers
  above).
- **Highlight band geometry on a third typeface** — exact to 0.01 pt against a
  PDFKit reference on a provably identical line (defect 5). The band work is the
  strongest part of this codebase.
- **The shipped suites, all three.** `npm test` — 39 passed, 0 failed.
  `npx electron test/ui-test.js` — 27 passed, 0 failed (including image
  move/resize/rotate, undo/redo, double-save idempotence, reopen, and the
  encrypted original left byte-identical). `npx electron test/sanity.js
  a lecture deck` — 9 passed, 0 failed: fit-on-open, refit-on-resize, fit-width,
  zoom in/out, ⌘0, deep scroll rendering page 58, scroll-position preservation
  across a zoom, and paste-and-save at a fitted zoom. Note that two of the 27
  ui-test checks are self-referential (claims section, item 1), so treat the
  rotation coverage as 0 rather than 2.
- **Colour swatch on a selected annotation** — correctly snapshots for undo and
  sets the dirty flag (the counterexample that makes defect 4 clearly a bug and
  not a design choice).
- **Note/text-box empty-creation cleanup** and the temp-file-plus-rename save
  path were read but not independently re-exercised; the shipped suite covers
  both and passed.
