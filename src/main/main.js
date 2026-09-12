const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const isDev = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let mainWindow = null;

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
