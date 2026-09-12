const { contextBridge, ipcRenderer } = require('electron');

/**
 * Everything the renderer is allowed to touch. No direct fs/child_process
 * access is exposed — only the narrow, purpose-built calls below.
 */
contextBridge.exposeInMainWorld('crowdsense', {
  openVenue: () => ipcRenderer.invoke('dialog:open-venue'),
  saveVenue: (contents, defaultPath) =>
    ipcRenderer.invoke('dialog:save-venue', { contents, defaultPath }),
  writeFile: (filePath, contents) =>
    ipcRenderer.invoke('fs:write-file', { filePath, contents }),
  openImage: () => ipcRenderer.invoke('dialog:open-image'),
  exportPng: (dataUrl, defaultPath) =>
    ipcRenderer.invoke('dialog:export-png', { dataUrl, defaultPath }),

  onMenu: (channel, callback) => {
    const validChannels = [
      'menu:new-venue',
      'menu:import-venue',
      'menu:import-background',
      'menu:save-venue',
      'menu:save-venue-as',
      'menu:export-png',
      'menu:undo',
      'menu:redo',
      'menu:delete-selection',
    ];
    if (!validChannels.includes(channel)) return;
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
