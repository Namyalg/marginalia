# For the agent installing this tomorrow

You are setting up **Marginalia**, an Electron PDF annotator for macOS. Your job is
to get it running, verify it actually works, and leave it installed as a Mac app.
Follow this top to bottom. It should take about ten minutes, most of it waiting on
`npm install`.

## What it is

A PDF viewer where the page is a canvas. You highlight, underline, strike through,
draw shapes and arrows, type text boxes, and — the part that matters most — paste
images straight off the clipboard onto the page. Everything is written back as real
PDF annotation objects with their own appearance streams, so Preview, Acrobat and
anything else that reads PDF sees them as annotations, not as a flattened raster.
It autosaves; there is no Save button.

## 1. Install

```bash
git clone https://github.com/Namyalg/marginalia.git
cd marginalia
npm install
```

`npm install` runs `scripts/vendor-pdfjs.js` in a postinstall hook. That copies the
pdf.js worker and viewer CSS into `renderer/vendor/`, which is gitignored. If the
app opens to a blank page later, this hook is the first thing to re-run
(`node scripts/vendor-pdfjs.js`).

Requirements: macOS (Apple silicon or Intel), Node 18+. Nothing else — the PDF
engine and the font are vendored.

## 2. Run it

```bash
npm start
```

Open any PDF with ⌘O. Expect: the document fits to the window, its name sits in an
editable island at top left, and the toolbar floats at top centre.

## 3. Test it

Run the automated suite first. Every command here launches a real Electron window
and drives it with OS-level input events (`webContents.sendInputEvent`), not
synthetic DOM events — so **do not touch the keyboard or mouse while they run**, and
do not let the window lose focus. A few flaky failures per run usually mean the
harness window was not the OS key window, not a real regression; re-run before
believing one.

```bash
npm test              # PDF write/read round-trip, no UI — start here, it is fast
npm run test:ui       # the UI suite in a real window
npm run test:reopen   # the important one, see below
npm run test:all      # everything
```

`npm run test:reopen` is the test worth caring about. It launches the app three
separate times: draws a square, circle, arrow, line, ink stroke, text box and a
pasted image, then **quits the app entirely**, reopens the same file, drags every
one of those marks to a new place and retypes the text, quits again, and reopens to
confirm the edits stuck. Annotations staying live across a close-and-reopen is the
whole point of the tool; if only one thing passes, make it this.

Then use it like a person, which the automated tests cannot fully stand in for:

1. Open a PDF. Select a sentence and hit the highlighter — the band should hug the
   text the way Preview's does, not sit as a loose rectangle around the line.
2. Screenshot something (⌘⇧4) and press ⌘V. The image lands on the page. Drag a
   corner and confirm the **aspect ratio is locked**; drag the rotation grip.
3. Type a text box. Click away. Double-click it again — the cursor should land at
   the end of the text and you should be able to keep typing.
4. Drag any mark to a **different page**. It should cross over, not stop at the edge.
5. Toggle light/dark with the sun icon at top right.
6. Close the app. Reopen the same file. Everything you added should still be
   selectable, movable and editable.

Undo is ⌘Z. It is the only keyboard shortcut besides ⌘O, ⌘V and ⌘S — single-letter
tool shortcuts were deliberately removed, because typing the word "line" into a text
box used to switch you to the Line tool.

## 4. Install as a Mac app

```bash
npm run icon          # generates build/icon.icns
npm run pack          # builds dist/Marginalia-darwin-arm64/Marginalia.app
npm run install-app   # copies it to ~/Desktop and pins it to the Dock
```

The bundle is signed ad-hoc, so the first launch needs right-click → Open to get
past Gatekeeper. That is expected and not a bug.

## 5. One rule, please

**Never point a test or a script at a PDF that matters to someone.** Autosave is on
by default and will write into whatever file you open. Every test here works on a
throwaway copy in `test/fixtures/` for exactly this reason. This warning is in here
because the file-in-place behaviour once cost a real annotated document a repair job.

## If something is wrong

- Blank page on open → re-run `node scripts/vendor-pdfjs.js`.
- Text renders as boxes → the EB Garamond subset in `assets/fonts/` is missing.
- The optional PDFKit cross-checks need a `.venv` with PyObjC; without it they
  report "skipped" rather than failing. Skipping them is fine.

`README.md` has the full feature list and notes on how the annotation writing works.
