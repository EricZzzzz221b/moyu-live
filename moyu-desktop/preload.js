const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moyu', {
  send: (text) => ipcRenderer.invoke('moyu:send', text),
  hide: () => ipcRenderer.send('moyu:hide'),
  onFocus: (cb) => ipcRenderer.on('moyu:focus', () => cb()),
});
