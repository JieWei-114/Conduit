/**
 * Electron main process — boots the bundled conduit server in-process, then
 * opens a window pointing at it. Packaged builds set CONDUIT_STATIC to the
 * unpacked UI dir so the server can read it outside the asar.
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

// Ephemeral port (0 → OS picks a free one) so multiple instances / a running
// dev server never collide (EADDRINUSE). The real port comes back from start().
process.env.PORT = '0';
process.env.CONDUIT_NO_AUTOSTART = '1';

// In a packaged app the UI + server bundle live under resources/app.asar; the
// UI is unpacked (see electron-builder.asarUnpack) so the server reads it via fs.
if (app.isPackaged) {
  process.env.CONDUIT_STATIC = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist');
  // bundled protoc (used only if the machine has no system protoc on PATH)
  process.env.CONDUIT_PROTOC_HOME = path.join(process.resourcesPath, 'protoc');
  // persist UI settings in the per-user data dir (the app bundle is read-only)
  process.env.CONDUIT_DATA = path.join(app.getPath('userData'), 'conduit-data.json');
}

async function boot() {
  // server bundle sits next to this file (dist-electron/server.cjs)
  const { start } = require('./server.cjs');
  const { port } = await start(0); // 0 → OS-assigned free port

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0e1116',
    title: 'conduit',
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(`http://localhost:${port}`);

  // open external links in the real browser, not inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});
