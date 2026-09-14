# Claims log

Every factual claim this project relies on, with the source it was checked
against and the date. Anything not listed here is inference, not verified fact.

Environment: macOS 14.4 (23E214), Electron 44.3.0, pdfjs-dist 4.10.38,
pdf-lib 1.17.1. All checks run 2026-09-12.

---

### 1. The annotation tools macOS Preview offers

**Verified.** Extracted from Preview's own localisation table:

```
plutil -convert json -o - \
  /System/Applications/Preview.app/Contents/Resources/MainMenu.loctable
```

The Tools ▸ Annotate menu contains: Highlight Text, Underline Text, Strike
Through Text, Rectangle, Oval, Line, Arrow, Speech Bubble, Mask, Text, Note,
Signature, Redact — plus "Show Markup Toolbar" and "Highlights and Notes".

*Not implemented here:* Speech Bubble, Mask, Signature, Redact.

### 2. Preview is built on PDFKit

**Verified**, and this is the load-bearing claim behind the whole design.

```
otool -L /System/Applications/Preview.app/Contents/MacOS/Preview
  → /System/Library/Frameworks/PDFKit.framework/Versions/A/PDFKit (1266.4.2)

nm -u /System/Applications/Preview.app/Contents/MacOS/Preview | grep PDFAnnotation
  → _OBJC_CLASS_$_PDFAnnotation
    _PDFAnnotationSubtypeHighlight
    _PDFAnnotationSubtypeUnderline
    _PDFAnnotationSubtypeStrikeOut
    _PDFAnnotationSubtypeText
    _PDFAnnotationSubtypePopup
    _PDFAnnotationSubtypeLink
```

Preview does not merely link PDFKit — it imports the very annotation subtype
constants this app writes. That is why the test suite verifies output through
PDFKit (via PyObjC): it is the same code path Preview uses to read a file.

### 3. Apple does not document inserting images into a PDF in Preview

**Verified** against Apple's own documentation,
<https://support.apple.com/guide/preview/annotate-a-pdf-prvw11580/mac>
(fetched 2026-09-12). The page lists the markup tools; none of them insert or
paste an image onto a PDF page.

*Caveat, unverified:* community posts describe a copy/paste workaround in
Preview. Apple does not document it, and it is not a markup tool.

### 4. Highlight band geometry

**Measured**, not assumed. A highlight was created by PDFKit itself
(`test/pdfkit-highlight.py`) over a known line of `demo/attention.pdf`:

| | baseline | font size | band |
|---|---|---|---|
| PDF text metrics (pdf.js) | 371.035 | 9.9626 pt | — |
| PDFKit's own highlight | | | 368.86 → 377.86 |

Those ratios — 0.218 below the baseline, 0.685 above — turned out to be the
**font's own ascent and descent**, not universal constants. Checking a second
document proved it:

| document | font metrics | PDFKit's band | baseline |
|---|---|---|---|
| `attention.pdf` (Times) | ascent 0.685, descent −0.218 | 368.86 → 377.86 | 371.035 |
| lecture deck (sans) | ascent 0.770, descent −0.230 | 18.75 → 42.75 | 24.270 |

In both cases PDFKit's band is exactly `baseline + descent·size` to
`baseline + ascent·size`. pdf.js publishes those per-font values in
`textContent.styles`, so `snapBandToText()` uses them directly. Measured result
after the fix: `368.88 → 377.79` (within 0.07 pt) and `18.75 → 42.75` (exact).

The fixed constants remain only as a fallback for text whose font reports no
metrics. Ascent is capped at 1.0 em and descent at −0.35 em, because a few
fonts publish a bounding box instead of typographic metrics and would otherwise
produce bands that swallow neighbouring lines — that cap is a judgement call,
not something measured against PDFKit.

### 5. Electron 44 replaced the main-process clipboard API

**Verified** by introspection of Electron 44.3.0 at runtime.
`clipboard.readImage`, `writeImage`, `availableFormats`, `readBuffer` and
`writeBuffer` are all `undefined`. What exists is an async, web-shaped API:
`clipboard.read()` → `Promise<ClipboardItem[]>`, each with `.types` and
`.getType(type)` → `Blob`; `clipboard.write([new ClipboardItem({...})])`, with
`ClipboardItem` exported from the `electron` module.

A screenshot lands as `image/png`; a file copied in Finder lands as
`text/uri-list`. `main.js` handles both, and keeps the old synchronous path so
the app still runs on Electron ≤ 43.

### 6. pdf.js requires `--scale-factor` on the text layer container

**Verified** in the vendored `pdfjs-dist` 4.10.38 source: `TextLayer` sets
`font-size: calc(var(--scale-factor) * Npx)` and positions spans as
percentages. Without the CSS variable the spans lay out at their natural
browser width — in testing a line measured 567 pt wide instead of 468 pt, and
highlights overshot the text by ~100 pt. Set in `renderAllPages()`.

### 7. Encrypted PDFs, and the close prompt

**Verified**, after both were initially claimed without being exercised.

- `test/make-encrypted.py` builds a fixture with PDFKit using an *owner*
  password and no user password — the case where viewers open the file with no
  prompt, so the app really can reach its save path with an encrypted document.
  The test asserts the original is byte-identical afterwards and the annotated
  copy carries the highlight.
- The renderer `beforeunload` handler was measured and found to **silently
  cancel** the close: `win.close()` with unsaved changes left
  `win.isDestroyed() === false`, no dialog, no explanation. Replaced with a
  main-process `close` handler; all three branches (Save… / Don't Save /
  Cancel) are now exercised.

### 8. A test that could not see the bug it was for

An independent QA pass found that `/Rotate 90` and `/Rotate 270` pages were
being written **completely wrong** — our ink landed at x 9–17% of the page where
PDFKit's own highlight was at x 91–92% — while looking perfect on screen.

Two failures of this document's own rules made it possible:

1. The rotated-page test compared a quad built with `toPdf()` against an
   expectation *also* built with `toPdf()`. Self-consistent, and blind to a
   whole-frame error. §9 below claimed no test verified the writer with the
   writer; that claim was false for this check.
2. The supporting raster assertion only required that *some* pixels changed
   ("5.1% of pixels changed"), never *which*.

Root cause, once measured properly: pdf.js tags a text layer with
`data-main-rotation` and expects the host stylesheet to supply the matching
`transform` (its own `viewer.css` does). Without those rules the text layer was
never rotated, so every span sat in the wrong place and every selection-derived
quad was wrong. `toPdf()` itself was correct all along.

The replacement check rasterises our output and a PDFKit-authored reference and
requires the painted boxes to overlap and their corners to agree within 3% of
the page. It runs on `plain`, `rotated90`, `rotated270` and `cropoffset`.

### 9. Where the test numbers come from

No test verifies the PDF writer using the PDF writer. Independent engines only:

- **PDFKit via PyObjC** — annotation objects, subtypes, bounds, contents.
- **`qlmanage -t`** — CoreGraphics rasterisation, the same rendering stack
  Preview uses. Pixels are decoded by a small PNG decoder in `test/png.js`.
- **pdf.js** — reads back saved files in the app itself, a third engine.
