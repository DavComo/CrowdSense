const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const isDev = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let maskViewerWindow = null;
/** @type {BrowserWindow | null} */
let densityViewerWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }





  // The renderer's `beforeunload` handler (src/renderer/app.js) calls
  // preventDefault() when there are unsaved changes. In a real browser that
  // pops a native "leave site?" confirmation; Electron has no such built-in
  // dialog, so left unhandled it just silently blocks the close forever —
  // the window won't respond to the close button or Cmd+Q, only a force
  // quit. This is the documented fix: show our own dialog, and only let the
  // close through if the user explicitly confirms.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Leave Without Saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Discard unsaved changes?',
      message: 'This venue has unsaved changes.',
      detail: 'Closing now will discard them.',
    });
    if (choice === 0) event.preventDefault(); // allow the close to proceed
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Venue',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-venue'),
        },
        { type: 'separator' },
        {
          label: 'Import Venue…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:import-venue'),
        },
        {
          label: 'Import Background Image…',
          click: () => mainWindow?.webContents.send('menu:import-background'),
        },
        { type: 'separator' },
        {
          label: 'Save Venue',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save-venue'),
        },
        {
          label: 'Save Venue As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:save-venue-as'),
        },
        {
          label: 'Export as PNG…',
          click: () => mainWindow?.webContents.send('menu:export-png'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow?.webContents.send('menu:undo'),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => mainWindow?.webContents.send('menu:redo'),
        },
        { type: 'separator' },
        {
          label: 'Delete Selection',
          accelerator: 'Delete',
          click: () => mainWindow?.webContents.send('menu:delete-selection'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: file system access lives in the main process only. The renderer never
// touches Node's fs directly (nodeIntegration is off); it goes through the
// preload bridge, which calls these handlers.
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:open-venue', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Venue',
    properties: ['openFile'],
    filters: [{ name: 'CrowdSense Venue', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const contents = await fs.readFile(filePath, 'utf-8');
  return { filePath, contents };
});

ipcMain.handle('dialog:save-venue', async (_event, { contents, defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Venue',
    defaultPath: defaultPath || 'venue.crowdsense.json',
    filters: [{ name: 'CrowdSense Venue', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;

  await fs.writeFile(result.filePath, contents, 'utf-8');
  return { filePath: result.filePath };
});

ipcMain.handle('dialog:export-mask', async (_event, { contents, defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Simulation Mask',
    defaultPath: defaultPath || 'venue.mask.json',
    filters: [{ name: 'Simulation Mask', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;

  await fs.writeFile(result.filePath, contents, 'utf-8');
  return { filePath: result.filePath };
});

// A separate, independent window for inspecting a computed mask (see
// src/renderer/mask-viewer.js) — reused across calls rather than opening a
// new one each time, and just fed fresh data over IPC when it's already open.
ipcMain.handle('window:open-mask-viewer', async (_event, payload) => {
  if (!maskViewerWindow || maskViewerWindow.isDestroyed()) {
    maskViewerWindow = new BrowserWindow({
      width: 860,
      height: 780,
      minWidth: 480,
      minHeight: 420,
      title: 'CrowdSense — Mask Viewer',
      backgroundColor: '#1e1f22',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'mask-viewer-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await maskViewerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'mask-viewer.html'));
    maskViewerWindow.on('closed', () => { maskViewerWindow = null; });
  } else {
    maskViewerWindow.focus();
  }
  maskViewerWindow.webContents.send('mask-viewer:data', payload);
  return true;
});

// Same pattern as the mask viewer above, but for a finished density
// simulation result (see src/renderer/sim/density.js / density-viewer.js).
ipcMain.handle('window:open-density-viewer', async (_event, payload) => {
  if (!densityViewerWindow || densityViewerWindow.isDestroyed()) {
    densityViewerWindow = new BrowserWindow({
      width: 900,
      height: 820,
      minWidth: 520,
      minHeight: 480,
      title: 'CrowdSense — Density Playback',
      backgroundColor: '#1a1b1e',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'density-viewer-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await densityViewerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'density-viewer.html'));
    densityViewerWindow.on('closed', () => { densityViewerWindow = null; });
  } else {
    densityViewerWindow.focus();
  }
  densityViewerWindow.webContents.send('density-viewer:data', payload);
  return true;
});

ipcMain.handle('fs:write-file', async (_event, { filePath, contents }) => {
  await fs.writeFile(filePath, contents, 'utf-8');
  return true;
});

ipcMain.handle('dialog:open-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Background Image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  return { filePath, dataUrl };
});

ipcMain.handle('dialog:export-png', async (_event, { dataUrl, defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export as PNG',
    defaultPath: defaultPath || 'venue.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  await fs.writeFile(result.filePath, Buffer.from(base64, 'base64'));
  return { filePath: result.filePath };
});

ipcMain.handle('dialog:choose-export-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for exported density-map runs',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return { folderPath: result.filePaths[0] };
});

// Writes one simulation run's density maps to disk as raw binaries (not
// JSON — hundreds of frames × thousands of cells as nested JSON arrays is
// slow to parse at scale) plus a manifest referencing them by relative
// path — a data contract for an external (likely Python/numpy) layout
// optimizer to read later, not for the app itself to read back. See
// docs/DENSITY_SIMULATION.md.
ipcMain.handle('export:density-run', async (_event, { rootDir, payload }) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(rootDir, `run-${timestamp}`);
  const framesDir = path.join(runDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  const toBuffer = (typedArray) => Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);

  await fs.writeFile(path.join(runDir, 'domain_mask.bin'), toBuffer(Uint8Array.from(payload.domainMask)));
  await fs.writeFile(path.join(runDir, 'peak_density.bin'), toBuffer(Float32Array.from(payload.metrics.peakDensity)));

  const frameFiles = [];
  for (let i = 0; i < payload.frames.length; i++) {
    const name = `frame_${String(i).padStart(4, '0')}.bin`;
    await fs.writeFile(path.join(framesDir, name), toBuffer(Float32Array.from(payload.frames[i])));
    frameFiles.push(`frames/${name}`);
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    engine: payload.engine,
    venue: payload.venue,
    cols: payload.cols,
    rows: payload.rows,
    cellSize: payload.cellSize,
    originX: payload.originX,
    originY: payload.originY,
    unit: payload.unit,
    dt: payload.dt,
    totalTime: payload.totalTime,
    maxPeople: payload.maxPeople,
    rhoMax: payload.rhoMax,
    phaseSwitchTime: payload.phaseSwitchTime,
    // grid dtype/shape for every .bin file below: domain_mask.bin is
    // uint8, everything else (peak_density.bin, each frame) is float32 —
    // all shaped [rows, cols] in row-major order, e.g. in Python:
    //   np.fromfile(path, dtype=np.float32).reshape(rows, cols)
    times: payload.times,
    ledger: payload.ledger,
    metrics: { t95: payload.metrics.t95, peakDensity: 'peak_density.bin' },
    warnings: payload.warnings,
    domainMask: 'domain_mask.bin',
    frames: frameFiles, // one per entry in `times`, same order
  };
  await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { runDir };
});
