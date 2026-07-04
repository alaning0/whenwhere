const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const SERVER_PORT = process.env.PORT || '3002';
const isDev = !app.isPackaged;

let mainWindow = null;
let serverProcess = null;

function getServerEntry() {
  if (isDev) {
    return path.join(__dirname, '..', 'server', 'index.js');
  }
  return path.join(process.resourcesPath, 'server', 'index.js');
}

function getStaticDir() {
  if (isDev) {
    return '';
  }
  return path.join(process.resourcesPath, 'build');
}

function getBundledNodePath() {
  const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';
  return path.join(process.resourcesPath, binaryName);
}

function getServerEnv() {
  const env = {
    ...process.env,
    PORT: SERVER_PORT,
    WHENWHERE_CONFIG_DIR: app.getPath('userData'),
  };

  const staticDir = getStaticDir();
  if (staticDir) {
    env.WHENWHERE_STATIC_DIR = staticDir;
  }

  // Avoid Electron-specific env leaking into the Node server process
  delete env.ELECTRON_RUN_AS_NODE;

  return env;
}

function startBackend() {
  const serverEntry = getServerEntry();
  const env = getServerEnv();

  let command = 'node';
  const args = [serverEntry];

  // Pass paths as CLI args (reliable with spaces; also used as env fallback)
  args.push('--config-dir', app.getPath('userData'));
  args.push('--port', String(SERVER_PORT));

  const staticDir = getStaticDir();
  if (staticDir) {
    args.push('--static-dir', staticDir);
  }

  if (!isDev) {
    const bundledNode = getBundledNodePath();
    if (fs.existsSync(bundledNode)) {
      command = bundledNode;
    } else {
      // Fallback: run with Electron as Node (may break native modules)
      command = process.execPath;
      env.ELECTRON_RUN_AS_NODE = '1';
    }
  }

  serverProcess = spawn(command, args, {
    env,
    cwd: path.dirname(serverEntry),
    stdio: 'inherit',
    windowsHide: true,
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start WhenWhere server:', err);
  });

  serverProcess.on('exit', (code, signal) => {
    if (code && code !== 0) {
      console.error(`WhenWhere server exited with code ${code} (signal: ${signal})`);
    }
    serverProcess = null;
  });
}

function waitForServer(url, attempts = 60, delayMs = 250) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;

    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on('error', () => {
        remaining -= 1;
        if (remaining <= 0) {
          reject(new Error(`Server did not become ready at ${url}`));
          return;
        }
        setTimeout(tryOnce, delayMs);
      });
    };

    tryOnce();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'WhenWhere',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `http://localhost:${SERVER_PORT}`;

  mainWindow.loadURL(startUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function stopBackend() {
  if (!serverProcess) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(serverProcess.pid), '/f', '/t'], {
      windowsHide: true,
    });
  } else {
    serverProcess.kill('SIGTERM');
  }

  serverProcess = null;
}

ipcMain.handle('select-folder', async (_event, title) => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: title || 'Select folder',
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths?.length) {
    return null;
  }

  return result.filePaths[0];
});

app.whenReady().then(async () => {
  startBackend();

  try {
    await waitForServer(`http://localhost:${SERVER_PORT}/api/health`);
  } catch (err) {
    console.error(err.message);
    dialog.showErrorBox(
      'WhenWhere',
      'The photo server failed to start. Check the console for details.'
    );
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});
