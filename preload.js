const { contextBridge, ipcRenderer } = require('electron');
const API_CONFIG = require('./config.js');

contextBridge.exposeInMainWorld('ricky', {
  config: API_CONFIG,

  loadNotes: () => ipcRenderer.invoke('notes:load'),
  saveNote: (note) => ipcRenderer.invoke('notes:save', note),

  exaSearch: (query, numResults) => ipcRenderer.invoke('exa:search', query, numResults),

  generateImage: (prompt) => ipcRenderer.invoke('image:generate', prompt),
  editImage: (slot, editPrompt) => ipcRenderer.invoke('image:edit', slot, editPrompt),
  saveImageToSlot: (imageData, slotOverride) => ipcRenderer.invoke('image:save-slot', imageData, slotOverride),
  loadImageManifest: () => ipcRenderer.invoke('image:load-manifest'),
  readImageSlot: (slot) => ipcRenderer.invoke('image:read-slot', slot),

  launchApp: (name) => ipcRenderer.invoke('computer:launch', name),
  typeText: (text) => ipcRenderer.invoke('computer:type', text),
  pressKey: (key) => ipcRenderer.invoke('computer:press', key),
  openUrl: (url) => ipcRenderer.invoke('computer:open-url', url),

  setOrbMode: (enable) => ipcRenderer.invoke('window:orb', enable),
  isOrbMode: () => ipcRenderer.invoke('window:is-orb'),
  onOrbMode: (cb) => ipcRenderer.on('ui:orb-mode', (_e, v) => cb(v))
});
