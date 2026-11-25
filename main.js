const { app, BrowserWindow, ipcMain, systemPreferences, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const API_CONFIG = require('./config.js');

const NOTES_PATH = path.join(app.getPath('userData'), 'local-notes.json');
const ASSETS_DIR = path.join(app.getPath('userData'), 'assets');
const MANIFEST_PATH = path.join(ASSETS_DIR, 'manifest.json');
const SLOT_COUNT = 16;

let mainWindow = null;
let orbMode = false;
let savedBounds = null;

// ── Persistence ──

function loadNotes() {
  try {
    if (fs.existsSync(NOTES_PATH)) return JSON.parse(fs.readFileSync(NOTES_PATH, 'utf8'));
  } catch (_) { /* empty */ }
  return [];
}

function saveNotes(notes) {
  fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
  fs.writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2), 'utf8');
}

function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_PATH)) return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (_) { /* empty */ }
  return Array.from({ length: SLOT_COUNT }, (_, i) => ({ slot: i + 1, file: null, prompt: null }));
}

function saveManifest(manifest) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function assetPath(filename) {
  return path.join(ASSETS_DIR, filename);
}

// ── Window / Orb Mode ──

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 900,
    minHeight: 540,
    title: 'JARVIS',
    backgroundColor: '#00000000',
    transparent: true,
    frame: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile('index.html');
}

function enterOrbMode() {
  if (!mainWindow || orbMode) return;
  savedBounds = mainWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  orbMode = true;
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setResizable(false);
  mainWindow.setSize(76, 76);
  mainWindow.setPosition(20, workArea.y + workArea.height - 96);
  mainWindow.webContents.send('ui:orb-mode', true);
}

function exitOrbMode() {
  if (!mainWindow || !orbMode) return;
  orbMode = false;
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setResizable(true);
  if (savedBounds) mainWindow.setBounds(savedBounds);
  else mainWindow.setSize(1280, 720);
  mainWindow.center();
  mainWindow.webContents.send('ui:orb-mode', false);
}

// ── Desktop Automation (macOS shell — no approval dialogs) ──

async function launchApplication(appName) {
  const map = {
    browser: 'Safari',
    safari: 'Safari',
    chrome: 'Google Chrome',
    firefox: 'Firefox',
    vscode: 'Visual Studio Code',
    'visual studio code': 'Visual Studio Code',
    cursor: 'Cursor',
    terminal: 'Terminal',
    finder: 'Finder'
  };
  const name = map[appName.toLowerCase()] || appName;
  await execAsync(`open -a ${JSON.stringify(name)}`);
  return { launched: name };
}

async function typeText(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  await execAsync(`osascript -e 'set the clipboard to (do shell script "echo ${b64} | base64 -D")' -e 'tell application "System Events" to keystroke "v" using command down'`);
  return { typed: text.length };
}

async function pressKey(key) {
  const codes = { enter: 36, return: 36, tab: 48, escape: 53, space: 49 };
  const code = codes[key.toLowerCase()];
  if (code !== undefined) {
    await execAsync(`osascript -e 'tell application "System Events" to key code ${code}'`);
  } else {
    await execAsync(`osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(key)}'`);
  }
  return { key };
}

async function openUrl(url) {
  await execAsync(`open ${JSON.stringify(url)}`);
  return { url };
}

// ── Exa Search ──

async function exaSearch(query, numResults = 5) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_CONFIG.EXA_API_KEY
    },
    body: JSON.stringify({
      query,
      numResults,
      type: 'auto',
      contents: { text: { maxCharacters: 800 } }
    })
  });
  if (!res.ok) throw new Error(`Exa search failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Imagen / Gemini Image ──

async function generateImage(prompt) {
  const models = ['imagen-4.0-fast-generate-001', 'imagen-3.0-generate-002'];
  let lastErr;
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': API_CONFIG.GEMINI_API_KEY
          },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1 }
          })
        }
      );
      if (!res.ok) {
        lastErr = new Error(await res.text());
        continue;
      }
      const data = await res.json();
      const b64 = data.predictions?.[0]?.bytesBase64Encoded
        || data.predictions?.[0]?.image?.bytesBase64Encoded;
      if (!b64) throw new Error('No image in response');
      return { base64: b64, mimeType: 'image/png', prompt, model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Image generation failed');
}

async function editImage(referencePath, editPrompt) {
  const imageBytes = fs.readFileSync(referencePath);
  const base64 = imageBytes.toString('base64');
  const mime = referencePath.endsWith('.jpg') || referencePath.endsWith('.jpeg')
    ? 'image/jpeg' : 'image/png';

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_CONFIG.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: `Edit this image precisely: ${editPrompt}. Preserve the subject and style while applying the requested change.` },
            { inlineData: { mimeType: mime, data: base64 } }
          ]
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    }
  );

  if (!res.ok) {
    const fallback = await generateImage(`${editPrompt}. Based on previous image context.`);
    return fallback;
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return {
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'image/png',
        prompt: editPrompt,
        model: 'gemini-2.0-flash-exp-image-generation'
      };
    }
  }
  return generateImage(`${editPrompt}. Maintain prior composition and style.`);
}

function shiftSlotsAndInsert(manifest, newEntry) {
  const occupied = manifest.filter((s) => s.file);
  const shifted = [{ ...newEntry, slot: 1 }, ...occupied.map((s, i) => ({ ...s, slot: i + 2 }))];
  while (shifted.length < SLOT_COUNT) {
    shifted.push({ slot: shifted.length + 1, file: null, prompt: null });
  }
  return shifted.slice(0, SLOT_COUNT);
}

async function saveImageToSlot({ base64, mimeType, prompt }, slotOverride) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const manifest = loadManifest();
  const filename = `asset_${Date.now()}.png`;
  fs.writeFileSync(assetPath(filename), Buffer.from(base64, 'base64'));

  const entry = { file: filename, prompt, mimeType: mimeType || 'image/png', createdAt: new Date().toISOString() };
  let updated;
  if (slotOverride) {
    const idx = manifest.findIndex((s) => s.slot === slotOverride);
    if (idx >= 0) manifest[idx] = { ...manifest[idx], ...entry };
    updated = manifest;
  } else {
    updated = shiftSlotsAndInsert(manifest, entry);
  }
  saveManifest(updated);
  return { manifest: updated, filename };
}

// ── App Lifecycle ──

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC ──

ipcMain.handle('notes:load', () => loadNotes());
ipcMain.handle('notes:save', (_e, note) => {
  const notes = loadNotes();
  const entry = { id: Date.now().toString(36), text: String(note), createdAt: new Date().toISOString() };
  notes.unshift(entry);
  saveNotes(notes);
  return entry;
});

ipcMain.handle('exa:search', (_e, query, numResults) => exaSearch(query, numResults));

ipcMain.handle('image:generate', (_e, prompt) => generateImage(prompt));
ipcMain.handle('image:edit', (_e, slot, editPrompt) => {
  const manifest = loadManifest();
  const item = manifest.find((s) => s.slot === slot);
  if (!item?.file) throw new Error(`No image in slot ${slot}`);
  return editImage(assetPath(item.file), editPrompt);
});
ipcMain.handle('image:save-slot', (_e, imageData, slotOverride) => saveImageToSlot(imageData, slotOverride));
ipcMain.handle('image:load-manifest', () => {
  const manifest = loadManifest();
  return manifest.map((s) => {
    if (!s.file) return { ...s, dataUrl: null };
    const buf = fs.readFileSync(assetPath(s.file));
    const mime = s.mimeType || 'image/png';
    return {
      ...s,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`
    };
  });
});
ipcMain.handle('image:read-slot', (_e, slot) => {
  const manifest = loadManifest();
  const item = manifest.find((s) => s.slot === slot);
  if (!item?.file) return null;
  const buf = fs.readFileSync(assetPath(item.file));
  return {
    slot,
    prompt: item.prompt,
    base64: buf.toString('base64'),
    mimeType: item.mimeType || 'image/png',
    dataUrl: `data:${item.mimeType || 'image/png'};base64,${buf.toString('base64')}`
  };
});

ipcMain.handle('computer:launch', (_e, appName) => launchApplication(appName));
ipcMain.handle('computer:type', (_e, text) => typeText(text));
ipcMain.handle('computer:press', (_e, key) => pressKey(key));
ipcMain.handle('computer:open-url', (_e, url) => openUrl(url));

ipcMain.handle('window:orb', (_e, enable) => {
  if (enable) enterOrbMode();
  else exitOrbMode();
  return orbMode;
});
ipcMain.handle('window:is-orb', () => orbMode);
