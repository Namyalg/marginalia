'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** The renderer gets exactly these four capabilities -- no fs, no clipboard,
 *  no Node. Everything privileged stays in the main process. */
contextBridge.exposeInMainWorld('api', {
  openPdf: (path) => ipcRenderer.invoke('pdf:open', path),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:image'),
  savePdf: (payload) => ipcRenderer.invoke('pdf:save', payload),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  setDirty: (flag) => ipcRenderer.send('doc:dirty', flag),
  confirmDiscard: () => ipcRenderer.invoke('doc:confirmDiscard'),
  pasteIntoField: () => ipcRenderer.invoke('edit:paste'),
  saveFinished: (ok) => ipcRenderer.send('doc:saveFinished', !!ok),
  autosaveAllowed: () => ipcRenderer.invoke('doc:autosaveAllowed'),
  renameDoc: (from, name) => ipcRenderer.invoke('doc:rename', { from, name }),
  existingMarks: (bytes) => ipcRenderer.invoke('pdf:existing', bytes),

  onMenu: (handler) => {
    const channels = ['menu:open', 'menu:openPath', 'menu:save', 'menu:saveAs',
      'menu:undo', 'menu:redo', 'menu:paste', 'menu:delete', 'menu:tool', 'menu:zoom',
      'menu:rotate', 'menu:fit', 'window:fullscreen'];
    for (const c of channels) {
      // Strip the channel's prefix, whatever it is: "menu:save" -> "save",
      // "window:fullscreen" -> "fullscreen". A fixed slice(5) mangled any
      // prefix that was not exactly "menu:".
      const name = c.slice(c.indexOf(':') + 1);
      ipcRenderer.on(c, (_e, arg) => handler(name, arg));
    }
  },
});
