const { contextBridge, ipcRenderer } = require('electron');

/**
 * The optimizer progress/comparison window's bridge. It receives its
 * initial payload (the venue to optimize + the crowd-sim panel's current
 * settings) from the main window, then drives its own work from here —
 * running the optimizer, and later the before/after density comparison —
 * rather than being handed a finished result like the mask/density
 * viewers are.
 */
contextBridge.exposeInMainWorld('optimizerViewer', {
  onData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('optimizer-viewer:data', listener);
    return () => ipcRenderer.removeListener('optimizer-viewer:data', listener);
  },
  runOptimizer: (venue, trainSamples) => ipcRenderer.invoke('optimizer:run', { venue, trainSamples }),
  onOptimizerProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('optimizer:progress', listener);
    return () => ipcRenderer.removeListener('optimizer:progress', listener);
  },
  onOptimizerLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('optimizer:log', listener);
    return () => ipcRenderer.removeListener('optimizer:log', listener);
  },
  applyVenueToEditor: (venue) => ipcRenderer.invoke('optimizer:apply-venue', venue),
  openDensityViewer: (payload) => ipcRenderer.invoke('window:open-density-viewer', payload),
});
