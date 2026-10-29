const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moyuDesktop', {
  opacity: (delta) => ipcRenderer.invoke('moyu:opacity', delta),
  top: () => ipcRenderer.invoke('moyu:top'),
  quit: () => ipcRenderer.send('moyu:quit'),
  listen: () => ipcRenderer.send('moyu:listen'),
  send: (text) => ipcRenderer.invoke('moyu:send', text),
  state: () => ipcRenderer.invoke('moyu:state'),
  onState: (cb) => ipcRenderer.on('moyu:state', (_event, state) => cb(state)),
  interactive: (on) => ipcRenderer.send('moyu:interactive', Boolean(on)),
});
