const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whenwhere', {
  selectFolder: (title) => ipcRenderer.invoke('select-folder', title),
  isElectron: true,
});
