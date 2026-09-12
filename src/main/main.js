const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn } = require('node:child_process');

const isDev = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let maskViewerWindow = null;
/** @type {BrowserWindow | null} */
let densityViewerWindow = null;
/** @type {BrowserWindow | null} */
let optimizerViewerWindow = null;

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

// Same pattern again, for the "Optimize Layout…" progress window. Unlike
// the two above, this window drives its own long-running work (it calls
// optimizer:run itself once loaded, rather than being handed a finished
// result) — see optimizer-viewer.js.
ipcMain.handle('window:open-optimizer-viewer', async (_event, payload) => {
  if (!optimizerViewerWindow || optimizerViewerWindow.isDestroyed()) {
    optimizerViewerWindow = new BrowserWindow({
      width: 720,
      height: 760,
      minWidth: 480,
      minHeight: 480,
      title: 'CrowdSense — Optimize Layout',
      backgroundColor: '#1a1b1e',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'optimizer-viewer-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await optimizerViewerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'optimizer-viewer.html'));
    optimizerViewerWindow.on('closed', () => { optimizerViewerWindow = null; });
  } else {
    optimizerViewerWindow.focus();
  }
  optimizerViewerWindow.webContents.send('optimizer-viewer:data', payload);
  return true;
});

// The optimizer-viewer window can't reach the main window's venue model
// directly (separate renderer, separate JS context) — it asks main.js to
// forward the optimized venue over, and app.js in the main window applies
// it to the editor.
ipcMain.handle('optimizer:apply-venue', async (_event, venue) => {
  mainWindow?.webContents.send('optimizer:apply-venue-to-editor', venue);
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

// ---------------------------------------------------------------------------
// Layout optimizer (optimizer/ — a semi-separate Python project merged into
// this repo: its own Hughes-continuum simulator, a data factory, a small
// surrogate net, and a CMA-ES-style search — see optimizer/run_pipeline.py).
// It re-simulates from the venue file directly; it does not need the JS
// engines' own output, so this spawns it and reads its result back.
// ---------------------------------------------------------------------------

const OPTIMIZER_DIR = path.join(__dirname, '..', '..', 'optimizer');
const OPTIMIZER_RUNS_DIR = path.join(OPTIMIZER_DIR, 'data', 'optimize-runs');
// Bounds for the "Training samples" field in the editor's Crowd Simulation
// panel (run_pipeline.py's CROWDSENSE_N) — clamped here so a malformed or
// wildly out-of-range value from the renderer can't hang the app on an
// absurdly long run, or spawn Python with zero/negative samples. A CLI user
// can still go higher by setting CROWDSENSE_N directly before `npm start`.
const DEFAULT_TRAIN_SAMPLES = 100;
const MIN_TRAIN_SAMPLES = 20;
const MAX_TRAIN_SAMPLES = 1000;

/** The optimizer's own virtualenv (see optimizer/SETUP.md) — never the
 * system Python, so its one real dependency (numpy) doesn't need to be
 * installed system-wide, and never numpy-less system Python by accident. */
function resolveOptimizerPython() {
  const venvPython = process.platform === 'win32'
    ? path.join(OPTIMIZER_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(OPTIMIZER_DIR, '.venv', 'bin', 'python3');
  return fsSync.existsSync(venvPython) ? venvPython : null;
}

/** Runs the full train→search→verify loop (run_pipeline.py) on `venue`,
 * streaming progress back to the invoking window as it goes, and
 * resolving with the winning layout once the process exits. Each
 * invocation gets its own timestamped subfolder under
 * optimizer/data/optimize-runs/ (gitignored, same spirit as
 * optimizer/data/density-runs/ before it) so concurrent/repeated runs
 * never collide and the input venue + result are both kept together. */
ipcMain.handle('optimizer:run', async (event, { venue, trainSamples }) => {
  const pythonPath = resolveOptimizerPython();
  if (!pythonPath) {
    throw new Error(
      "Optimizer environment not set up yet. Run once from a terminal:\n"
      + '  cd optimizer && python3 -m venv .venv && .venv/bin/pip install numpy\n'
      + 'See optimizer/SETUP.md.',
    );
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OPTIMIZER_RUNS_DIR, `run-${runId}`);
  await fs.mkdir(runDir, { recursive: true });
  const venuePath = path.join(runDir, 'venue.json');
  const outPath = path.join(runDir, 'optimized-venue.json');
  await fs.writeFile(venuePath, JSON.stringify(venue, null, 2));

  // The editor's "Training samples" field (falls back to the env var, then
  // the built-in default, for anyone invoking this outside the UI). More
  // samples means a more thorough search but a proportionally longer run —
  // see docs/OPTIMIZER.md's Performance section.
  const requested = Number(trainSamples);
  const nTrain = Number.isFinite(requested) && requested > 0
    ? Math.round(Math.min(Math.max(requested, MIN_TRAIN_SAMPLES), MAX_TRAIN_SAMPLES))
    : Number(process.env.CROWDSENSE_N) || DEFAULT_TRAIN_SAMPLES;

  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [
      path.join(OPTIMIZER_DIR, 'run_pipeline.py'),
      '--venue', venuePath,
      '--out', outPath,
      '--progress-json',
    ], {
      cwd: OPTIMIZER_DIR,
      env: { ...process.env, CROWDSENSE_N: String(nTrain) },
    });

    let stderrTail = '';
    const forward = (line, isErr) => {
      const prefix = 'CROWDSENSE_PROGRESS ';
      if (!isErr && line.startsWith(prefix)) {
        try {
          event.sender.send('optimizer:progress', JSON.parse(line.slice(prefix.length)));
          return;
        } catch { /* not valid JSON after all — fall through to a raw log line */ }
      }
      event.sender.send('optimizer:log', { line, isErr });
    };
    const wireLines = (stream, isErr) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line) forward(line, isErr);
          idx = buf.indexOf('\n');
        }
      });
      stream.on('end', () => { if (buf) forward(buf, isErr); });
    };
    wireLines(child.stdout, false);
    wireLines(child.stderr, true);
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });

    child.on('error', reject);
    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Optimizer exited with code ${code}.\n${stderrTail}`));
        return;
      }
      try {
        const result = JSON.parse(await fs.readFile(outPath, 'utf-8'));
        resolve({ runDir, resultPath: outPath, result });
      } catch (err) {
        reject(err);
      }
    });
  });
});
