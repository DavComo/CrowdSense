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
  exportMask: (contents, defaultPath) =>
    ipcRenderer.invoke('dialog:export-mask', { contents, defaultPath }),
  openMaskViewer: (payload) => ipcRenderer.invoke('window:open-mask-viewer', payload),
  openDensityViewer: (payload) => ipcRenderer.invoke('window:open-density-viewer', payload),
  openOptimizerViewer: (payload) => ipcRenderer.invoke('window:open-optimizer-viewer', payload),

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

  // The optimizer-viewer window can't reach this window's venue model
  // directly (separate renderer) — it asks main.js to forward the
  // optimized venue here once the user chooses to apply it.
  onApplyOptimizedVenue: (callback) => {
    const listener = (_event, venue) => callback(venue);
    ipcRenderer.on('optimizer:apply-venue-to-editor', listener);
    return () => ipcRenderer.removeListener('optimizer:apply-venue-to-editor', listener);
  },
});
