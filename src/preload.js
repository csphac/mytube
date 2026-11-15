const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('mytube', {
  ensureTools: () => ipcRenderer.invoke('tools:ensure'),
  onToolsProgress: (cb) => subscribe('tools:progress', cb),
  fetchInfo: (url) => ipcRenderer.invoke('video:info', url),
  getDefaultDir: () => ipcRenderer.invoke('dir:default'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  startDownload: (opts) => ipcRenderer.invoke('download:start', opts),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryTranscript: (folder) => ipcRenderer.invoke('library:transcript', folder),
  onDownloadEvent: (cb) => subscribe('download:event', cb),
});