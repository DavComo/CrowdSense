const { contextBridge, ipcRenderer } = require('electron');

/**
 * A deliberately tiny bridge for the mask debug viewer window — it only
 * ever receives data pushed from the main window, nothing else.
 */
contextBridge.exposeInMainWorld('maskViewer', {
  onData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mask-viewer:data', listener);
    return () => ipcRenderer.removeListener('mask-viewer:data', listener);
  },
});
