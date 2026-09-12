const { contextBridge, ipcRenderer } = require('electron');

/**
 * A deliberately tiny bridge for the density playback window — it only
 * ever receives a finished simulation result pushed from the main window,
 * nothing else.
 */
contextBridge.exposeInMainWorld('densityViewer', {
  onData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('density-viewer:data', listener);
    return () => ipcRenderer.removeListener('density-viewer:data', listener);
  },
});
