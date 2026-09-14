'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, Menu, shell, protocol } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { writeAnnotations, readExistingAnnotations } = require('./lib/pdf-writer');

let win = null;

/** Mirrors the renderer's unsaved-changes flag, so the main process can put up
 *  a real confirmation before the window goes away. */
let hasUnsavedChanges = false;
let forceClose = false;
/** Autosave is on by default; it is disabled for documents we must not
 *  overwrite (an encrypted original), which the renderer is told about. */
let autosaveEnabled = true;

/** Ask the user what to do about unsaved annotations.
 *  @returns 'save' | 'discard' | 'cancel' */
async function askAboutUnsaved(verb) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save…', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'You have unsaved annotations.',
    detail: `Do you want to save them before ${verb}?`,
  });
  return ['save', 'discard', 'cancel'][response];
}

/** Resolves when the renderer reports how the save it was asked for ended.
 *  It always reports -- including when it declined or the user cancelled --
 *  so this never sits waiting on a save that is not coming. */
let pendingSave = null;
function waitForClean(timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!hasUnsavedChanges) return resolve(true);
    const done = (ok) => {
      clearTimeout(timer);
      pendingSave = null;
      resolve(ok && !hasUnsavedChanges);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    pendingSave = done;
  });
}

// Serving the renderer over a real scheme (rather than file://) gives it a
// proper origin, which is what lets the CSP above allow the pdf.js worker.
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const root = path.join(__dirname, 'renderer');
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const body = await fsp.readFile(file);
      const type = {
        '.html': 'text/html', '.css': 'text/css',
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.map': 'application/json', '.png': 'image/png',
        '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2',
      }[path.extname(file)] || 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 900, minWidth: 820, minHeight: 560,
    title: 'Marginalia',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#2b2d31',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium pauses rendering in an occluded window, which would leave a
      // page half-drawn -- and stall pdf.js mid-render -- whenever the app is
      // behind another window. Rendering a document must not depend on focus.
      backgroundThrottling: false,
    },
  });
  win.loadURL('app://bundle/index.html');
  win.on('closed', () => { win = null; });

  // The window buttons only exist when not full screen, and the document-name
  // island has to keep clear of them.
  const tellFullScreen = () => {
    if (win && !win.isDestroyed()) send('window:fullscreen', win.isFullScreen());
  };
  win.on('enter-full-screen', tellFullScreen);
  win.on('leave-full-screen', tellFullScreen);
  win.webContents.on('did-finish-load', tellFullScreen);

  // A renderer 'beforeunload' handler cancels the close silently -- the window
  // simply refuses to go away with no explanation. Handle it here instead.
  win.on('close', (event) => {
    if (forceClose || !hasUnsavedChanges) return;
    event.preventDefault();
    (async () => {
      const choice = await askAboutUnsaved('closing');
      if (choice === 'cancel') return;
      if (choice === 'save') {
        send('menu:save');
        const saved = await waitForClean();
        if (!saved) return;                 // save cancelled or failed: stay open
      }
      forceClose = true;
      if (win && !win.isDestroyed()) win.destroy();
    })();
  });
}

// --------------------------------------------------------------------- menu

const send = (channel, payload) => win && win.webContents.send(channel, payload);

function buildMenu() {
  // Deliberately no accelerators on the tools: a bare letter would fire while
  // you were typing into a text box or the document name.
  const tool = (label, id) => ({ label, click: () => send('menu:tool', id) });
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:saveAs') },
        { type: 'separator' },
        { label: 'Close Window', role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu:redo') },
        // CmdOrCtrl resolves to Cmd only on macOS; bind Control explicitly so
        // Ctrl+Z works too, as asked.
        { label: 'Undo (Ctrl)', accelerator: 'Control+Z', visible: false,
          click: () => send('menu:undo') },
        { label: 'Redo (Ctrl)', accelerator: 'Control+Shift+Z', visible: false,
          click: () => send('menu:redo') },
        { type: 'separator' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('menu:paste') },
        { label: 'Paste and Match Style', accelerator: 'Shift+CmdOrCtrl+V',
          click: () => send('menu:paste') },
        { label: 'Delete Annotation', accelerator: 'Backspace', click: () => send('menu:delete') },
        { type: 'separator' },
        { label: 'Select All Text', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        tool('Select', 'select'),
        { type: 'separator' },
        tool('Rectangle', 'square'),
        tool('Ellipse', 'circle'),
        tool('Arrow', 'arrow'),
        tool('Line', 'line'),
        tool('Draw', 'ink'),
        tool('Text', 'freetext'),
        { type: 'separator' },
        tool('Highlight', 'highlight'),
        tool('Underline', 'underline'),
        tool('Strikethrough', 'strikeout'),
        { type: 'separator' },
        { label: 'Rotate Image Left', accelerator: 'CmdOrCtrl+[',
          click: () => send('menu:rotate', -90) },
        { label: 'Rotate Image Right', accelerator: 'CmdOrCtrl+]',
          click: () => send('menu:rotate', 90) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('menu:zoom', 1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('menu:zoom', -1) },
        { type: 'separator' },
        { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+0',
          click: () => send('menu:fit', 'fit') },
        { label: 'Fit Width', accelerator: 'Shift+CmdOrCtrl+0',
          click: () => send('menu:fit', 'fit-width') },
        { label: 'Actual Size', accelerator: 'Alt+CmdOrCtrl+0',
          click: () => send('menu:zoom', 'actual') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- clipboard

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic']);

/** Read width/height straight out of a PNG's IHDR chunk.
 *  Exact, and independent of nativeImage, whose scale-factor reporting varies
 *  between Electron versions. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504E47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Convert arbitrary image bytes to PNG via nativeImage. */
function toPngBytes(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  return img.toPNG();
}

function fileUrlToPath(line) {
  try {
    const u = new URL(line.trim());
    if (u.protocol !== 'file:') return null;
    return decodeURIComponent(u.pathname);
  } catch { return null; }
}

function imageFromFile(file) {
  if (!IMAGE_EXT.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file);
  const png = pngSize(raw) ? raw : toPngBytes(raw);
  if (!png) return null;
  return { png, origin: 'file:' + path.basename(file) };
}

/**
 * Reads an image off the clipboard.
 *
 * Two shapes count as "an image I copied":
 *   1. Real bitmap data -- a screenshot (⌘⇧4), or a copy from Preview/a browser.
 *   2. A file copied in Finder, which puts a file URL on the clipboard rather
 *      than any pixels, so we load it from disk.
 *
 * Electron 44 replaced the synchronous main-process clipboard (readImage,
 * availableFormats, ...) with an async, web-shaped one: clipboard.read()
 * resolves to ClipboardItems carrying Blobs. Both are handled, so the app is
 * not pinned to one Electron generation.
 */
/** Plain text on the clipboard, across both clipboard APIs. */
async function readClipboardText() {
  if (typeof clipboard.readText === 'function') {
    const t = clipboard.readText();
    if (t) return t;
  }
  try {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t === 'text/plain');
      if (type) return (await (await item.getType(type)).text());
    }
  } catch { /* no text available */ }
  return '';
}

async function readClipboardImage(attempt = 0) {
  const modern = typeof clipboard.readImage !== 'function';
  let png = null, origin = 'bitmap', seen = [];

  if (modern) {
    const items = await clipboard.read();
    for (const item of items) {
      seen.push(...item.types);

      const pngType = item.types.find((t) => t === 'image/png');
      const anyImage = pngType || item.types.find((t) => t.startsWith('image/'));
      if (anyImage) {
        const buf = Buffer.from(await (await item.getType(anyImage)).arrayBuffer());
        png = pngType ? buf : toPngBytes(buf);
        if (png) break;
      }

      const uriType = item.types.find((t) => t === 'text/uri-list');
      if (uriType) {
        const text = await (await item.getType(uriType)).text();
        for (const line of text.split(/\r?\n/)) {
          const file = fileUrlToPath(line);
          const got = file && imageFromFile(file);
          if (got) { png = got.png; origin = got.origin; break; }
        }
        if (png) break;
      }
    }
  } else {
    // Legacy synchronous API (Electron <= 43).
    seen = clipboard.availableFormats();
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      png = img.toPNG();
    } else {
      const file = fileUrlToPath(clipboard.read('public.file-url') || '');
      const got = file && imageFromFile(file);
      if (got) { png = got.png; origin = got.origin; }
    }
  }

  if (!png && modern) {
    // No image: fall back to whatever text is there, so ⌘V always does
    // *something* sensible with the clipboard.
    const text = await readClipboardText();
    if (text && text.trim()) return { ok: true, kind: 'text', text, origin: 'text' };
  }

  if (!png && attempt === 0) {
    // The pasteboard occasionally hands back an item list without its image
    // data when another process is mid-write. Observed once during testing;
    // one short retry makes it a non-event.
    await new Promise((r) => setTimeout(r, 90));
    return readClipboardImage(1);
  }

  if (!png && !modern) {
    const t = await readClipboardText();
    if (t && t.trim()) return { ok: true, kind: 'text', text: t, origin: 'text' };
  }

  if (!png) {
    // Name what IS on the clipboard -- "nothing happened" is the worst answer.
    const human = [...new Set(seen)]
      .filter((t) => !t.startsWith('electron application/'))
      .join(', ');
    return {
      ok: false,
      reason: human
        ? `The clipboard holds ${human} — no image. Copy an image or take a screenshot with ⌘⇧4.`
        : 'The clipboard is empty. Copy an image, or take a screenshot with ⌘⇧4.',
    };
  }

  const size = pngSize(png) || { width: 0, height: 0 };
  return {
    ok: true, kind: 'image', origin,
    data: png.toString('base64'),
    width: size.width,
    height: size.height,
  };
}

// -------------------------------------------------------------------- save

/** Write via a temp file in the same directory, then rename, so a failed
 *  save can never leave the user with a truncated original. */
async function safeWrite(target, bytes) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, target);
}

// --------------------------------------------------------------------- ipc

ipcMain.handle('pdf:open', async (_e, givenPath) => {
  let file = givenPath;
  if (!file) {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    file = r.filePaths[0];
  }
  try {
    const bytes = await fsp.readFile(file);
    win.setTitle(`${path.basename(file)} — Marginalia`);
    win.setRepresentedFilename(file);
    return { ok: true, path: file, name: path.basename(file), data: bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('clipboard:image', () => readClipboardImage());

ipcMain.handle('pdf:save', async (_e, { sourceBytes, sourcePath, annotations, images, saveAs, removeAt }) => {
  try {
    // Always re-derive from the bytes as originally opened. Saving twice then
    // produces original + current annotations, never a doubled-up file.
    const src = Buffer.from(sourceBytes);

    // An encrypted source can load with ignoreEncryption but may not save to a
    // file other viewers accept -- never overwrite the original in that case.
    const encrypted = /\/Encrypt\b/.test(src.subarray(-4096).toString('latin1')) ||
                      /\/Encrypt\s+\d+\s+\d+\s+R/.test(src.toString('latin1'));
    autosaveEnabled = !encrypted;

    let target = sourcePath;
    if (saveAs || encrypted) {
      const r = await dialog.showSaveDialog(win, {
        defaultPath: sourcePath.replace(/\.pdf$/i, ' (annotated).pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        message: encrypted && !saveAs
          ? 'This PDF is encrypted. Annotations will be written to a copy, ' +
            'leaving the original untouched.'
          : undefined,
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      target = r.filePath;
    }

    const { bytes, written } = await writeAnnotations(src, annotations, images, removeAt);
    await safeWrite(target, bytes);

    win.setTitle(`${path.basename(target)} — Marginalia`);
    win.setRepresentedFilename(target);
    return { ok: true, path: target, name: path.basename(target), written, encrypted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); });

/** Rename the open document on disk. Returns the new path, or an explanation. */
ipcMain.handle('doc:rename', async (_e, { from, name }) => {
  try {
    const clean = String(name || '').trim()
      .replace(/[\/\\:]/g, '-')          // characters a filename cannot hold
      .replace(/^\.+/, '')
      .slice(0, 120);
    if (!clean) return { ok: false, error: 'A name is required.' };

    const dir = path.dirname(from);
    const target = path.join(dir, clean.toLowerCase().endsWith('.pdf') ? clean : `${clean}.pdf`);
    if (target === from) return { ok: true, path: from, name: path.basename(from) };
    if (fs.existsSync(target)) {
      return { ok: false, error: `“${path.basename(target)}” already exists here.` };
    }
    await fsp.rename(from, target);
    if (win) {
      win.setTitle(`${path.basename(target)} — Marginalia`);
      win.setRepresentedFilename(target);
    }
    return { ok: true, path: target, name: path.basename(target) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('doc:dirty', (_e, flag) => { hasUnsavedChanges = !!flag; });

ipcMain.on('doc:saveFinished', (_e, ok) => { if (pendingSave) pendingSave(ok); });

ipcMain.handle('doc:autosaveAllowed', () => autosaveEnabled);

/** Marks already in the file, with any pasted images recovered, so the
 *  renderer can take them over and let you edit them again. */
ipcMain.handle('pdf:existing', async (_e, sourceBytes) => {
  try {
    return { ok: true, marks: await readExistingAnnotations(Buffer.from(sourceBytes)) };
  } catch (e) {
    return { ok: false, error: e.message, marks: [] };
  }
});

/** Native paste into the focused text field. The ⌘V accelerator belongs to the
 *  menu, so a text box being edited would otherwise never see it. */
ipcMain.handle('edit:paste', () => { if (win) win.webContents.paste(); });

/** Used before opening another document over unsaved work. */
ipcMain.handle('doc:confirmDiscard', async () => {
  if (!hasUnsavedChanges) return true;
  const choice = await askAboutUnsaved('opening another file');
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    send('menu:save');
    return waitForClean();
  }
  return true;
});

// ------------------------------------------------------------------ startup

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

/** A .pdf passed on the command line, e.g. `npm start -- some/file.pdf`. */
function pdfFromArgv() {
  const arg = process.argv.slice(1).find(
    (a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
  return arg ? path.resolve(arg) : null;
}

app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();
  createWindow();

  const initial = pdfFromArgv();
  if (initial) {
    win.webContents.once('did-finish-load', () => send('menu:openPath', initial));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Opening a PDF from Finder / `open -a`.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  const deliver = () => send('menu:openPath', filePath);
  if (win) deliver(); else app.whenReady().then(() => setTimeout(deliver, 400));
});
