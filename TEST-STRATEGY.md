# Test strategy — `test/interaction.js`

Three user-visible bugs shipped with a green suite. In every case the test
*simulated* the interaction instead of performing it, and asserted on a value
it had produced itself. This suite is built so that neither mistake is possible
to make quietly.

Run it:

```bash
npx electron test/interaction.js [file.pdf]     # ~3 min, 76 checks
```

One line per check, a tally at the end, non-zero exit on any failure.

---

## What makes a check trustworthy here

**1. The input has to be real input.**
Everything goes through `webContents.sendInputEvent` — `mouseMove` /
`mouseDown` / `mouseUp` with a real `clickCount`, and `keyDown` / `char` /
`keyUp`. Those enter Chromium's actual input pipeline, so hit-testing, focus,
click-count tracking, text composition and native defaults all behave as they
do for a user. There is no `dispatchEvent` in this file, and no app function is
ever called to *perform* a user action — only to read state or to set up a
document.

Coordinates are window-relative CSS pixels, converted from geometry read out of
the renderer. Check #1 proves `innerWidth/innerHeight === getContentBounds()`
before anything else runs, and the invariant is re-asserted after every
`setSize`; if it ever breaks, every coordinate below is silently wrong and the
run says so instead of passing.

**2. The assertion has to come back by a different road than the action went
out.** Independent readbacks used here:

| Route | Used for |
|---|---|
| `document.activeElement` (+ `selectionStart/End`) | is the caret really in the editor, and where |
| `window.getSelection()`, read **while the button is still down** | did the drag actually select text |
| the rendered SVG overlay (`[data-id]`, `<text>`/`<tspan>`) | what the page paints, versus what state claims |
| `getComputedStyle` | theme actually changed, not just the attribute |
| PDFKit via PyObjC (`test/verify-pdfkit.py`) | what Preview will read out of the saved file |
| CoreGraphics (`qlmanage -t`) + `test/png.js` | where the ink physically lands |
| the filesystem (`fs.stat`, `readdir`) | autosave, rename, and that the original is untouched |

**3. Every input helper proves the input landed before the check asserts what
it did.** A mistyped coordinate must fail, not pass vacuously because nothing
happened. So `expectHit(x, y, …)` runs Chromium's own `elementFromPoint` at the
target before the click; `setToolByKey` verifies the toolbar's active button;
`dragSelectText` returns the browser's selection string and the check requires
it to be non-empty; `doubleClick` records the presses the renderer actually saw
and reports their spacing if the check fails.

---

## Which assertions are independent, and which are not

**Independent.** Everything in the table above. In particular the rotated- and
cropped-page checks compare our saved highlight with one **PDFKit authored
itself** over the same phrase, and then require CoreGraphics to paint both in
the same place. Nothing in that chain runs the code under test twice.

**Not independent — stated in the file, at the check:**

- **⌘-accelerators cannot be exercised at all.** `sendInputEvent` injects into
  the web contents and never reaches the native `NSMenu`, so ⌘Z, ⌘S, ⌘V never
  fire from a harness (measured: an `osascript` "System Events keystroke"
  detour does not reach the window either). Those checks assert the
  accelerator is *bound* (`menuItem().accelerator`) and then invoke the menu
  item's own handler — which covers everything downstream of the accelerator
  and nothing of the binding. `Ctrl+Z` / `Ctrl+Shift+Z` *are* exercised as real
  keys, because the renderer handles them itself.
- **Typing.** `ta.value` is read to check the caret and to guard mid-typing;
  the *result* is always asserted through the painted overlay or through PDFKit
  reading the saved file.
- **Scrolling to page 40** uses `scrollIntoView`, and the 200%-zoom setup uses
  `reflow(2)`. Both are staging, not the thing under test; the zoom *buttons*
  are exercised by real clicks in their own check.
- **Window focus.** A harness window is never truly the front application.
  Checks that depend on OS focus (window-blur commit, and the caret after a
  double-click late in the run) assert the invariant that holds either way —
  nothing typed may go missing — and say in their output when the caret could
  not be judged.
- **`document.hasFocus()` is not used as a gate.** Check #2 is a functional
  probe instead: send a key, require the renderer to have acted on it.

---

## The traps, and the rule that prevents each

| Trap | What it looked like | Rule |
|---|---|---|
| **Circular expectation** | The rotated-page test built its expected quad with the same `toPdf()` it was testing, and passed on a whole-frame error. | Build the expectation with an engine the app does not use. Here: PDFKit authors the reference highlight, CoreGraphics rasterises both, the painted boxes must overlap. `compareToReference()` is the only comparator, and it never calls app code. |
| **"Some pixels changed"** | A raster check that only required *some* difference — ink anywhere satisfied it. | Assert *where*. `yellowBox()` returns the ink's bounding box as a fraction of the page, and the checks compare it against the reference's box, not against zero. |
| **Synthetic events** | `ta.dispatchEvent(new FocusEvent('blur'))` "proved" that clicking away committed a text box; on macOS a click on a button never fires `blur`, so the real path was broken. | Never `dispatchEvent`. Commit is exercised five ways by real clicks and keys — page, grey margin, toolbar, another tool, Escape — and each one asserts the editor is gone *and* the overlay paints the text. |
| **Stale node held across a click** | A bare synthetic `dblclick` on a node reference the test was holding; selecting rebuilds the overlay, so the two real clicks land on different nodes and the browser's `dblclick` never fires. | Re-resolve every target by annotation id immediately before touching it (`annotRect(id)`); no DOM node ever crosses a click boundary. `doubleClick()` sends two real presses with `clickCount` 1 then 2. |
| **Asserting the wrong thing about the editor** | The old test asserted the text *value* changed, which a re-render could satisfy. | Assert `document.activeElement` is the textarea, and that `selectionStart === value.length` — a caret at the end rather than a select-all, because a select-all means the next keystroke wipes the box. |
| **Vacuous pass** | A coordinate that hits nothing produces no state change, and a "nothing bad happened" assertion passes. | `expectHit()` before the click; `dragSelectText()` returns the real selection; the 3px-drift and 2px-twitch checks assert both what must happen and what must not. |
| **Handles and groups masquerading as the mark** | `[data-id]` also matches the 8×8 selection handles and the full-page `<g>` wrapper, so "the annotation's rect" can silently be the whole page. | `annotRect()` resolves the mark's own `.hit` body, excluding `.handle`, `.rothandle` and `<g>`. |
| **Self-referential setup** | A check that draws its own history and then measures it. | Undo/redo checks open a fresh copy and draw exactly two shapes, then count what the **overlay paints**, never `state.undo.length`. |
| **Testing the user's real file** | The app autosaves, so opening the real document edits it. | Every document is copied into a temp dir first and the copy is opened; one check asserts `state.path` is under that temp dir. The original is never opened. |
| **A hang eating the budget** | `dialog.showSaveDialog` blocks forever with nobody to click it. | No Save-As path and no encrypted fixture. Saves go to the already-known path; `qlmanage` always gets an explicit `timeout`; each check has a 45s cap and the run has a hard 8-minute stop, always ending in `app.exit()`. |

---

## Coverage map

`A` harness invariants · `B` every tool drawn by real drags, text markup by
real drag-selection · `C` text boxes: insert, type, five ways to commit,
reopen by double-click and by Enter, appending, empty boxes surviving a drag
and never reaching the file · `D` what reaches the file, read by PDFKit and
CoreGraphics · `E` undo/redo by keys, by buttons, by menu handlers · `F`
autosave with no save action, including with an editor opened inside the
debounce · `G` image paste, move, aspect-locked resize, Shift-resize, rotate,
each verified in the saved PDF · `H` theme, zoom buttons, fit, and annotating
at 200% · `I` `/Rotate 90`, `/Rotate 270` and CropBox-offset pages against a
PDFKit-authored reference · `J` page 40 of a 72-page deck, pre-existing markup
preserved · `K` imprecise input: 3px drift, 2px twitch, slow double-click,
just-inside/just-outside, release outside the window, press-and-hold · `L`
real typing: tool letters, Backspace, multi-line, accents, non-WinAnsi,
wrapping · `M` order of operations: undo a brand-new box, undo with the editor
open, the history edges, redo-stack clearing · `N` the document-name field ·
`O` moving targets: scroll away and back, zoom with a selection, resize
mid-edit, focus loss mid-edit · `P` 40 marks on a page, overlapping shapes,
overlapping text boxes.

## Not covered, and why

- **⌘-key accelerators as key presses** — unreachable from a harness (above).
- **Save As, encrypted originals, the unsaved-changes sheet on close** — all
  end in a modal nobody can dismiss; they stay in `test/ui-test.js`, which
  drives them through the IPC layer.
- **Real drag-and-drop from Finder, and a real screenshot on the clipboard** —
  the clipboard is seeded with `ClipboardItem` instead, which is the same code
  path the app reads but not the same way the bytes got there.
- **Multi-monitor / HiDPI scale changes mid-run.**
