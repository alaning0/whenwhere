const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const SERVER_PORT = process.env.PORT || '3002';
const isDev = !app.isPackaged;
const GITHUB_REPO_URL = 'https://github.com/alaning0/whenwhere';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let mainWindow = null;
let serverProcess = null;
let updateCheckFromMenu = false;
let updateDownloadedInfo = null;
let autoUpdater = null;

function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require('electron-updater'));
  }
  return autoUpdater;
}

function showAbout() {
  const version = app.getVersion();
  dialog
    .showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: 'About WhenWhere',
      message: 'WhenWhere',
      detail: [
        `Version ${version}`,
        '',
        'Visualize photos on maps and timelines using GPS metadata.',
        '',
        GITHUB_REPO_URL,
      ].join('\n'),
      buttons: ['Open GitHub', 'OK'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) {
        shell.openExternal(GITHUB_REPO_URL);
      }
    });
}

function installDownloadedUpdate() {
  stopBackend();
  // Silent install, then relaunch the app
  getAutoUpdater().quitAndInstall(true, true);
}

function promptToInstallUpdate(version) {
  dialog
    .showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: 'Update ready',
      message: `WhenWhere ${version} is ready to install`,
      detail: 'The app will restart to apply the update. You do not need to download anything yourself.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        installDownloadedUpdate();
      }
    });
}

function setupAutoUpdater() {
  const updater = getAutoUpdater();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('update-available', (info) => {
    console.log(`Update available: ${info.version}`);
    if (updateCheckFromMenu && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update available',
        message: `WhenWhere ${info.version} is available`,
        detail: 'Downloading in the background. You will be asked to restart when it is ready.',
        buttons: ['OK'],
      });
    }
  });

  updater.on('update-not-available', () => {
    if (updateCheckFromMenu) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'info',
        title: 'No updates',
        message: 'You are up to date.',
        detail: `WhenWhere ${app.getVersion()} is the latest version.`,
        buttons: ['OK'],
      });
    }
    updateCheckFromMenu = false;
  });

  updater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    if (updateCheckFromMenu) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: err.message || String(err),
        buttons: ['OK'],
      });
    }
    updateCheckFromMenu = false;
  });

  updater.on('update-downloaded', (info) => {
    updateDownloadedInfo = info;
    updateCheckFromMenu = false;
    console.log(`Update downloaded: ${info.version}`);
    promptToInstallUpdate(info.version);
  });

  setTimeout(() => {
    updater.checkForUpdates().catch((err) => {
      console.error('Startup update check failed:', err);
    });
  }, 5000);

  setInterval(() => {
    updater.checkForUpdates().catch((err) => {
      console.error('Scheduled update check failed:', err);
    });
  }, UPDATE_CHECK_INTERVAL_MS);
}

function checkForUpdatesManual() {
  if (isDev) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: 'Updates',
      message: 'Auto-update is only available in the installed app.',
      detail: 'Install a release build to receive updates from GitHub.',
      buttons: ['OK'],
    });
    return;
  }

  if (updateDownloadedInfo) {
    promptToInstallUpdate(updateDownloadedInfo.version);
    return;
  }

  updateCheckFromMenu = true;
  getAutoUpdater()
    .checkForUpdates()
    .catch((err) => {
      updateCheckFromMenu = false;
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: err.message || String(err),
        buttons: ['OK'],
      });
    });
}

function createAppMenu() {
  const helpMenu = {
    label: 'Help',
    submenu: [
      {
        label: 'Check for Updates…',
        click: () => checkForUpdatesManual(),
      },
      {
        label: 'About WhenWhere',
        click: () => showAbout(),
      },
      {
        label: 'View on GitHub',
        click: () => shell.openExternal(GITHUB_REPO_URL),
      },
    ],
  };

  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
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
    helpMenu,
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { label: 'About WhenWhere', click: () => showAbout() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
  createAppMenu();
  if (!isDev) {
    setupAutoUpdater();
  }
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
