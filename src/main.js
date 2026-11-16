const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { ensureTools } = require('./binaries');
const {
  isYouTubeUrl,
  fetchInfo,
  downloadAll,
  cancelAll,
} = require('./downloader');
const {
  addRoot,
  isInsideRoots,
  scanLibrary,
  readTranscriptPreview,
  deleteItem,
} = require('./library');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let win = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'MyTube',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  if (!gotLock) return;

  protocol.handle('media', async (request) => {
    // The renderer lives on a file:// origin, so fetch() needs CORS headers.
    const cors = { 'Access-Control-Allow-Origin': '*' };
    let filePath;
    try {
      filePath = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400, headers: cors });
    }
    if (!isInsideRoots(filePath)) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }
    const res = await net.fetch(pathToFileURL(filePath).toString());
    return new Response(res.body, {
      status: res.status,
      headers: { ...Object.fromEntries(res.headers), ...cors },
    });
  });

  createWindow();

  ipcMain.handle('tools:ensure', async () => {
    try {
      await ensureTools((p) => send('tools:progress', p));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('video:info', async (_e, url) => {
    if (!isYouTubeUrl(url)) {
      return { ok: false, error: 'Please enter a valid YouTube URL.' };
    }
    try {
      const info = await fetchInfo(url);
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('dir:default', () =>
    path.join(app.getPath('downloads'), 'MyTube')
  );

  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('download:start', async (_e, opts) => {
    try {
      addRoot(opts.outputDir);
      const result = await downloadAll(opts, (event) =>
        send('download:event', event)
      );
      return { ok: true, ...result };
    } catch (err) {
      const cancelled = /Cancelled/i.test(err.message);
      send('download:event', {
        type: cancelled ? 'cancelled' : 'error',
        message: err.message,
      });
      return { ok: false, cancelled, error: err.message };
    }
  });

  ipcMain.handle('download:cancel', () => {
    cancelAll();
    return { ok: true };
  });

  ipcMain.handle('shell:openPath', async (_e, p) => {
    return shell.openPath(p);
  });

  ipcMain.handle('shell:showItem', (_e, p) => {
    shell.showItemInFolder(p);
    return { ok: true };
  });

  ipcMain.handle('library:list', () => {
    try {
      return { ok: true, items: scanLibrary() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('library:transcript', (_e, folder) => {
    try {
      return { ok: true, text: readTranscriptPreview(folder) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('library:delete', (_e, folder) => {
    try {
      deleteItem(folder);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS the app stays in the Dock; let in-flight downloads finish.
  if (process.platform !== 'darwin') {
    cancelAll();
    app.quit();
  }
});