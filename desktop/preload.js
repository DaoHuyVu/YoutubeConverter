const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
    isElectron: true,
    showInFolder: (relativeDownloadUrl) => ipcRenderer.invoke('show-in-folder', relativeDownloadUrl),
});
