'use strict';

// ── DOM ──

const rickyFace = document.getElementById('rickyFace');
const mouthPath = document.getElementById('mouthPath');
const statusLabel = document.getElementById('statusLabel');
const transcript = document.getElementById('transcript');
const connectionDot = document.getElementById('connectionDot');
const artifactsContent = document.getElementById('artifactsContent');
const imageMasonry = document.getElementById('imageMasonry');
const eyes = document.querySelectorAll('.eye');
const btnMic = document.getElementById('btnMic');
const btnComputer = document.getElementById('btnComputer');
const btnCapabilities = document.getElementById('btnCapabilities');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxCaption = document.getElementById('lightboxCaption');
const lightboxClose = document.getElementById('lightboxClose');
const lightboxBackdrop = document.getElementById('lightboxBackdrop');
const orbRestore = document.getElementById('orbRestore');

// ── Constants ──

const MODEL = 'gemini-3.1-flash-live-preview';
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const SLOT_COUNT = 16;

const JARVIS_SYSTEM = [
  'You are JARVIS — Just A Rather Very Intelligent System — the user\'s desktop AI butler, modeled after the Iron Man assistant.',
  'Respond IMMEDIATELY with brief, precise acknowledgments ("Certainly, sir.", "Right away.", "At once.") before executing actions.',
  'Speak in a refined British butler tone: calm, confident, dry wit, never verbose.',
  'You respond to "JARVIS", "Jarvis", "Ricky", and direct address. Treat both names as yours.',
  'Use tools proactively when the user asks to search, generate images, edit photos, control the computer, save notes, or draw diagrams.',
  'For Mermaid diagrams: output ONLY valid mermaid syntax inside ```mermaid fences. No prose inside the block. Use simple node IDs (A, B, C). Always close blocks. Avoid special characters in labels — use quotes for labels with spaces.',
  'When generating images, confirm briefly then call generate_image. When editing an open photo, call edit_image with the slot number and edit instruction.',
  'When user says "show me the menu" or asks about capabilities, call show_capabilities.',
  'When user says "pull up photo N" or "open image N", call view_image with slot N.',
  'In Computer Control Mode, execute launch_app, type_text, press_key, and open_url without asking for confirmation.'
].join(' ');

// ── State ──

let ws = null;
let setupComplete = false;
let micEnabled = true;
let computerMode = false;
let micStream = null;
let captureContext = null;
let playbackContext = null;
let workletNode = null;
let micSource = null;
let activeSources = [];
let audioQueue = [];
let isPlaying = false;
let nextPlayTime = 0;
let speakingAnimFrame = null;
let lightboxSlot = null;
let mermaidInitialized = false;

// ── Audio Playback ──

function initPlaybackContext() {
  if (!playbackContext) playbackContext = new AudioContext({ sampleRate: OUTPUT_RATE });
  return playbackContext;
}

function base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  return float32;
}

function enqueueAudio(base64Pcm) {
  const ctx = initPlaybackContext();
  const samples = base64ToFloat32(base64Pcm);
  const buffer = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
  buffer.copyToChannel(samples, 0);
  audioQueue.push(buffer);
  drainAudioQueue();
}

function drainAudioQueue() {
  if (isPlaying || audioQueue.length === 0) return;
  isPlaying = true;
  setSpeaking(true);
  const ctx = initPlaybackContext();
  const buffer = audioQueue.shift();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  activeSources.push(source);
  const now = ctx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
  source.onended = () => {
    activeSources = activeSources.filter((s) => s !== source);
    isPlaying = false;
    if (audioQueue.length > 0) drainAudioQueue();
    else if (activeSources.length === 0) setSpeaking(false);
  };
}

function interruptPlayback() {
  audioQueue = [];
  nextPlayTime = 0;
  isPlaying = false;
  for (const source of activeSources) {
    try { source.stop(); } catch (_) { /* noop */ }
  }
  activeSources = [];
  setSpeaking(false);
}

// ── Microphone ──

async function startMicrophone() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  captureContext = new AudioContext();
  await captureContext.audioWorklet.addModule('pcm-capture-processor.js');
  micSource = captureContext.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(captureContext, 'pcm-capture-processor');
  workletNode.port.onmessage = (event) => {
    if (!micEnabled || !ws || ws.readyState !== WebSocket.OPEN || !setupComplete) return;
    sendAudioChunk(event.data);
  };
  micSource.connect(workletNode);
}

function toggleMic() {
  micEnabled = !micEnabled;
  btnMic.setAttribute('aria-pressed', String(micEnabled));
  btnMic.classList.toggle('muted', !micEnabled);
  btnMic.textContent = micEnabled ? 'Toggle Microphone' : 'Mic Off';
  if (!micEnabled && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }
  setStatus(micEnabled ? 'Listening' : 'Mic muted', micEnabled);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function sendAudioChunk(pcmBuffer) {
  ws.send(JSON.stringify({
    realtimeInput: {
      audio: { mimeType: `audio/pcm;rate=${INPUT_RATE}`, data: arrayBufferToBase64(pcmBuffer) }
    }
  }));
}

function sendTextToModel(text) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ realtimeInput: { text } }));
  }
}

// ── Gemini Live Setup ──

function buildSetupMessage() {
  return {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }
        }
      },
      systemInstruction: { parts: [{ text: JARVIS_SYSTEM }] },
      tools: [{
        functionDeclarations: [
          {
            name: 'save_local_note',
            description: 'Save a short note locally.',
            parameters: {
              type: 'object',
              properties: { note: { type: 'string', description: 'Note text' } },
              required: ['note']
            }
          },
          {
            name: 'exa_web_search',
            description: 'Search the web via Exa for current information, news, or facts.',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                num_results: { type: 'integer', description: 'Number of results (1-8)' }
              },
              required: ['query']
            }
          },
          {
            name: 'render_mermaid_diagram',
            description: 'Render an architectural or flow diagram using Mermaid syntax.',
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Diagram title' },
                diagram: { type: 'string', description: 'Valid Mermaid diagram source code only' }
              },
              required: ['diagram']
            }
          },
          {
            name: 'generate_image',
            description: 'Generate a new image from a text prompt. Result appears in asset slot 1.',
            parameters: {
              type: 'object',
              properties: { prompt: { type: 'string', description: 'Image generation prompt' } },
              required: ['prompt']
            }
          },
          {
            name: 'edit_image',
            description: 'Edit an existing image slot using image-to-image. Use when user wants to modify a photo while viewing it or references a slot.',
            parameters: {
              type: 'object',
              properties: {
                slot: { type: 'integer', description: 'Asset slot number 1-16' },
                edit_prompt: { type: 'string', description: 'Edit instruction e.g. add blue sunglasses' }
              },
              required: ['slot', 'edit_prompt']
            }
          },
          {
            name: 'view_image',
            description: 'Open an asset in full-screen lightbox view.',
            parameters: {
              type: 'object',
              properties: { slot: { type: 'integer', description: 'Slot 1-16' } },
              required: ['slot']
            }
          },
          {
            name: 'show_capabilities',
            description: 'Display the capabilities menu in the artifacts panel.',
            parameters: { type: 'object', properties: {} }
          },
          {
            name: 'launch_app',
            description: 'Launch a desktop application (browser, vscode, cursor, terminal, etc). Only when computer control mode is active.',
            parameters: {
              type: 'object',
              properties: { app_name: { type: 'string', description: 'App name: browser, chrome, vscode, cursor, terminal' } },
              required: ['app_name']
            }
          },
          {
            name: 'type_text',
            description: 'Type text into the active window. Computer control mode only.',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string', description: 'Text to type' } },
              required: ['text']
            }
          },
          {
            name: 'press_key',
            description: 'Press a key (enter, tab, escape, space). Computer control mode only.',
            parameters: {
              type: 'object',
              properties: { key: { type: 'string', description: 'Key name' } },
              required: ['key']
            }
          },
          {
            name: 'open_url',
            description: 'Open a URL in the default browser. Computer control mode only.',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string', description: 'Full URL' } },
              required: ['url']
            }
          }
        ]
      }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' }
    }
  };
}

function connectWebSocket() {
  const apiKey = window.ricky.config.GEMINI_API_KEY;
  ws = new WebSocket(`${WS_BASE}?key=${encodeURIComponent(apiKey)}`);
  ws.onopen = () => {
    setStatus('Handshaking…');
    ws.send(JSON.stringify(buildSetupMessage()));
  };
  ws.onmessage = (event) => {
    if (event.data instanceof Blob) {
      event.data.arrayBuffer().then(handleBinaryFrame);
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      handleBinaryFrame(event.data);
      return;
    }
    try { handleServerMessage(JSON.parse(event.data)); }
    catch (err) { console.error('Parse error:', err); }
  };
  ws.onerror = () => setStatus('Connection error', false);
  ws.onclose = () => { setConnected(false); setStatus('Offline', false); };
}

function handleBinaryFrame(buffer) {
  try {
    handleServerMessage(JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))));
  } catch (_) {
    enqueueAudio(arrayBufferToBase64(buffer));
  }
}

function handleServerMessage(msg) {
  if (msg.setupComplete !== undefined) {
    setupComplete = true;
    setConnected(true);
    setStatus('Online — say "JARVIS"', true);
    rickyFace.classList.add('listening');
    return;
  }
  if (msg.toolCall) { handleToolCall(msg.toolCall); return; }
  const content = msg.serverContent;
  if (!content) return;

  if (content.interrupted) {
    interruptPlayback();
    setStatus('Listening', true);
  }

  if (content.inputTranscription?.text) {
    const text = content.inputTranscription.text;
    transcript.textContent = text;
    handleVoiceCommands(text);
    interruptPlayback();
    setStatus('Listening', true);
  }

  if (content.outputTranscription?.text) {
    processOutputText(content.outputTranscription.text);
  }

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) enqueueAudio(part.inlineData.data);
      if (part.text) processOutputText(part.text);
    }
  }

  if (content.turnComplete) setStatus('Listening', true);
}

// ── Voice Command Shortcuts ──

function handleVoiceCommands(text) {
  const lower = text.toLowerCase();
  if (/show\s+(me\s+)?(the\s+)?menu/.test(lower) || lower.includes('capabilities')) {
    showCapabilitiesPanel();
  }
  const photoMatch = lower.match(/(?:pull\s+up|open|show|view)\s+(?:photo|image|picture|asset)\s+#?(\d{1,2})/);
  if (photoMatch) openLightbox(parseInt(photoMatch[1], 10));

  if (lightboxSlot && !photoMatch) {
    const editHints = ['give', 'swap', 'change', 'make', 'add', 'remove', 'edit', 'background'];
    if (editHints.some((h) => lower.includes(h))) {
      handleContextualEdit(text);
    }
  }
}

async function handleContextualEdit(instruction) {
  try {
    setStatus('Editing…', true);
    markSlotGenerating(1);
    const result = await window.ricky.editImage(lightboxSlot, instruction);
    await window.ricky.saveImageToSlot(result);
    await refreshImageGrid();
    const updated = await window.ricky.readImageSlot(1);
    if (updated) {
      lightboxSlot = 1;
      lightboxImg.src = updated.dataUrl;
      lightboxCaption.textContent = updated.prompt || instruction;
    }
    appendArtifact('Image Edit', `<p><strong>Slot 1 updated.</strong> ${escapeHtml(instruction)}</p>`);
    setStatus('Listening', true);
  } catch (err) {
    appendArtifact('Edit Error', `<p>${escapeHtml(err.message)}</p>`);
  }
}

// ── Tool Handlers ──

async function handleToolCall(toolCall) {
  const responses = [];
  for (const call of toolCall.functionCalls || []) {
    try {
      const result = await executeTool(call);
      responses.push({ id: call.id, name: call.name, response: { result } });
    } catch (err) {
      responses.push({ id: call.id, name: call.name, response: { error: err.message } });
    }
  }
  if (responses.length && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }
}

async function executeTool(call) {
  const args = call.args || {};
  switch (call.name) {
    case 'save_local_note': {
      const noteText = args.note || '';
      await window.ricky.saveNote(noteText);
      renderNotesBlock();
      return `Note saved: "${noteText}"`;
    }
    case 'exa_web_search': {
      const data = await window.ricky.exaSearch(args.query, args.num_results || 5);
      renderSearchResults(args.query, data);
      return `Found ${data.results?.length || 0} results for "${args.query}"`;
    }
    case 'render_mermaid_diagram': {
      const ok = await renderMermaidBlock(args.title || 'Diagram', args.diagram);
      if (!ok) throw new Error('Mermaid render failed — auto-correction requested');
      return 'Diagram rendered successfully';
    }
    case 'generate_image': {
      markSlotGenerating(1);
      const img = await window.ricky.generateImage(args.prompt);
      await window.ricky.saveImageToSlot(img);
      await refreshImageGrid();
      return `Image generated and placed in slot 1: "${args.prompt}"`;
    }
    case 'edit_image': {
      const slot = args.slot || lightboxSlot || 1;
      markSlotGenerating(1);
      const img = await window.ricky.editImage(slot, args.edit_prompt);
      await window.ricky.saveImageToSlot(img);
      await refreshImageGrid();
      if (lightboxSlot) {
        const updated = await window.ricky.readImageSlot(1);
        if (updated) { lightboxImg.src = updated.dataUrl; lightboxSlot = 1; }
      }
      return `Edited slot ${slot}, new version in slot 1`;
    }
    case 'view_image': {
      openLightbox(args.slot);
      return `Opened slot ${args.slot} in lightbox`;
    }
    case 'show_capabilities': {
      showCapabilitiesPanel();
      return 'Capabilities menu displayed';
    }
    case 'launch_app': {
      if (!computerMode) throw new Error('Computer control mode is off');
      return await window.ricky.launchApp(args.app_name);
    }
    case 'type_text': {
      if (!computerMode) throw new Error('Computer control mode is off');
      return await window.ricky.typeText(args.text);
    }
    case 'press_key': {
      if (!computerMode) throw new Error('Computer control mode is off');
      return await window.ricky.pressKey(args.key);
    }
    case 'open_url': {
      if (!computerMode) throw new Error('Computer control mode is off');
      return await window.ricky.openUrl(args.url);
    }
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

// ── Exa Search Rendering ──

function renderSearchResults(query, data) {
  clearEmptyPlaceholder();
  const results = data.results || [];
  let html = `<p><strong>Web search:</strong> ${escapeHtml(query)}</p>`;
  for (const r of results) {
    html += `<div class="search-result">
      <h4>${escapeHtml(r.title || 'Untitled')}</h4>
      <p>${escapeHtml((r.text || r.summary || '').slice(0, 400))}</p>
      ${r.url ? `<a href="#">${escapeHtml(r.url)}</a>` : ''}
      <span class="search-meta">${r.publishedDate ? escapeHtml(r.publishedDate) : ''}</span>
    </div>`;
  }
  appendArtifact('Search Results', html);
}

// ── Mermaid ──

async function initMermaid() {
  if (mermaidInitialized || typeof mermaid === 'undefined') return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    flowchart: { curve: 'basis' }
  });
  mermaidInitialized = true;
}

async function renderMermaidBlock(title, diagram) {
  await initMermaid();
  clearEmptyPlaceholder();
  const id = `mmd-${Date.now()}`;
  const block = document.createElement('div');
  block.className = 'artifact-block';
  block.innerHTML = `<div class="artifact-title">${escapeHtml(title)}</div><div class="artifact-body"><div class="mermaid-wrap" id="${id}"></div></div>`;
  artifactsContent.prepend(block);
  const container = document.getElementById(id);

  try {
    const { svg } = await mermaid.render(`${id}-svg`, diagram.trim());
    container.innerHTML = svg;
    return true;
  } catch (err) {
    container.innerHTML = `<div class="mermaid-error">${escapeHtml(err.message || String(err))}</div>`;
    sendTextToModel(
      `Mermaid diagram parse error — please fix and resend corrected diagram only:\n${err.message}\n\nOriginal:\n${diagram}`
    );
    return false;
  }
}

// ── Capabilities Panel ──

function showCapabilitiesPanel() {
  clearEmptyPlaceholder();
  const existing = document.getElementById('capabilitiesPanel');
  if (existing) { existing.scrollIntoView({ behavior: 'smooth' }); return; }

  const html = `<div class="capabilities-grid">
    <div class="cap-item"><h4>Voice Assistant</h4><p>Say "JARVIS" for instant voice control. Real-time speech with barge-in interruption.</p></div>
    <div class="cap-item"><h4>Web Search</h4><p>Exa-powered live web search with rich text results in Artifacts.</p></div>
    <div class="cap-item"><h4>Image Generation</h4><p>Imagen-powered assets in a 16-slot grid. Say "generate an image of…"</p></div>
    <div class="cap-item"><h4>Image Editing</h4><p>Open any slot, then voice-edit: "give him blue sunglasses", "swap the background".</p></div>
    <div class="cap-item"><h4>Diagrams</h4><p>Mermaid flowcharts and architecture diagrams with auto-error correction.</p></div>
    <div class="cap-item"><h4>Local Notes</h4><p>Save reminders and notes persistently on your device.</p></div>
    <div class="cap-item"><h4>Computer Control</h4><p>Launch apps, type text, press keys. Collapses to floating orb for hands-free use.</p></div>
    <div class="cap-item"><h4>Quick Commands</h4><p>"Show me the menu" · "Pull up photo 13" · "Generate an image of a fox"</p></div>
  </div>`;

  const block = document.createElement('div');
  block.className = 'artifact-block';
  block.id = 'capabilitiesPanel';
  block.innerHTML = `<div class="artifact-title">JARVIS Capabilities</div><div class="artifact-body">${html}</div>`;
  artifactsContent.prepend(block);
}

// ── Image Grid ──

function buildEmptyGrid() {
  imageMasonry.innerHTML = '';
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const slot = document.createElement('div');
    slot.className = 'image-slot empty';
    slot.dataset.slot = i;
    slot.innerHTML = `<span class="slot-label">#${i}</span><div class="slot-placeholder">—</div>`;
    slot.addEventListener('click', () => openLightbox(i));
    imageMasonry.appendChild(slot);
  }
}

function markSlotGenerating(slot) {
  const el = imageMasonry.querySelector(`[data-slot="${slot}"]`);
  if (el) el.classList.add('generating');
}

async function refreshImageGrid() {
  const manifest = await window.ricky.loadImageManifest();
  buildEmptyGrid();
  for (const item of manifest) {
    if (!item.file) continue;
    const el = imageMasonry.querySelector(`[data-slot="${item.slot}"]`);
    if (!el) continue;
    el.classList.remove('empty', 'generating');
    el.innerHTML = `<span class="slot-label">#${item.slot}</span>`;
    const img = document.createElement('img');
    img.src = item.dataUrl;
    img.alt = item.prompt || `Asset ${item.slot}`;
    el.appendChild(img);
  }
}

// ── Lightbox ──

async function openLightbox(slot) {
  if (slot < 1 || slot > SLOT_COUNT) return;
  const data = await window.ricky.readImageSlot(slot);
  if (!data) {
    appendArtifact('Notice', `<p>No image in slot ${slot}.</p>`);
    return;
  }
  lightboxSlot = slot;
  lightboxImg.src = data.dataUrl;
  lightboxCaption.textContent = data.prompt || `Asset #${slot}`;
  lightbox.classList.remove('hidden');
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  lightboxSlot = null;
}

// ── Computer Control / Orb ──

async function toggleComputerMode() {
  computerMode = !computerMode;
  btnComputer.setAttribute('aria-pressed', String(computerMode));
  btnComputer.classList.toggle('active', computerMode);
  if (computerMode) {
    await window.ricky.setOrbMode(true);
    document.body.classList.add('orb-mode');
    orbRestore.classList.remove('hidden');
    setStatus('Computer control active', true);
  } else {
    await window.ricky.setOrbMode(false);
    document.body.classList.remove('orb-mode');
    orbRestore.classList.add('hidden');
    setStatus('Listening', true);
  }
}

async function restoreFromOrb() {
  computerMode = false;
  btnComputer.setAttribute('aria-pressed', 'false');
  btnComputer.classList.remove('active');
  await window.ricky.setOrbMode(false);
  document.body.classList.remove('orb-mode');
  orbRestore.classList.add('hidden');
  setStatus('Listening', true);
}

window.ricky.onOrbMode((isOrb) => {
  document.body.classList.toggle('orb-mode', isOrb);
  orbRestore.classList.toggle('hidden', !isOrb);
});

// ── Artifacts Rendering ──

function clearEmptyPlaceholder() {
  const empty = artifactsContent.querySelector('.artifact-empty');
  if (empty) empty.remove();
}

function appendArtifact(title, html) {
  clearEmptyPlaceholder();
  const block = document.createElement('div');
  block.className = 'artifact-block';
  block.innerHTML = `<div class="artifact-title">${title}</div><div class="artifact-body">${html}</div>`;
  artifactsContent.prepend(block);
}

function processOutputText(text) {
  const mermaidMatch = text.match(/```mermaid\n([\s\S]*?)```/);
  if (mermaidMatch) {
    renderMermaidBlock('Diagram', mermaidMatch[1]);
    text = text.replace(/```mermaid[\s\S]*?```/g, '').trim();
  }
  if (text) appendArtifact('JARVIS', renderMarkdown(text));
}

function renderMarkdown(raw) {
  let html = escapeHtml(raw);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    if (lang === 'mermaid') return '';
    return `<pre><code>${code.trim()}</code></pre>`;
  });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul class="artifact-list">${m}</ul>`);
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  if (!html.startsWith('<')) html = `<p>${html}</p>`;
  return html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderNotesBlock() {
  const notes = await window.ricky.loadNotes();
  const items = notes.map((n) =>
    `<li>${escapeHtml(n.text)}<span class="note-time">${new Date(n.createdAt).toLocaleString()}</span></li>`
  ).join('');
  const body = `<ul class="artifact-list">${items}</ul>`;
  let existing = document.getElementById('localNotesBlock');
  if (existing) {
    existing.querySelector('.artifact-body').innerHTML = body;
  } else if (notes.length) {
    clearEmptyPlaceholder();
    const block = document.createElement('div');
    block.className = 'artifact-block';
    block.id = 'localNotesBlock';
    block.innerHTML = `<div class="artifact-title">Local Notes</div><div class="artifact-body">${body}</div>`;
    artifactsContent.prepend(block);
  }
}

// ── Face Animation ──

function setSpeaking(active) {
  rickyFace.classList.toggle('speaking', active);
  if (active) animateMouth();
  else {
    cancelAnimationFrame(speakingAnimFrame);
    mouthPath.setAttribute('d', 'M10,20 Q60,38 110,20');
  }
}

function animateMouth() {
  const t = performance.now() / 1000;
  const open = 18 + Math.sin(t * 12) * 10 + Math.sin(t * 7) * 5;
  mouthPath.setAttribute('d', `M10,20 Q60,${open + 20} 110,20`);
  if (rickyFace.classList.contains('speaking')) speakingAnimFrame = requestAnimationFrame(animateMouth);
}

function randomBlink() {
  eyes.forEach((eye) => {
    eye.classList.add('blinking');
    setTimeout(() => eye.classList.remove('blinking'), 180);
  });
  setTimeout(randomBlink, 2500 + Math.random() * 4000);
}

function setStatus(text, active) {
  statusLabel.textContent = text;
  statusLabel.classList.toggle('active', !!active);
}

function setConnected(connected) {
  connectionDot.classList.toggle('connected', connected);
  connectionDot.title = connected ? 'Connected' : 'Disconnected';
}

// ── Event Bindings ──

btnMic.addEventListener('click', toggleMic);
btnComputer.addEventListener('click', toggleComputerMode);
btnCapabilities.addEventListener('click', showCapabilitiesPanel);
lightboxClose.addEventListener('click', closeLightbox);
lightboxBackdrop.addEventListener('click', closeLightbox);
orbRestore.addEventListener('click', restoreFromOrb);

// ── Bootstrap ──

async function init() {
  randomBlink();
  buildEmptyGrid();
  btnMic.setAttribute('aria-pressed', 'true');

  try {
    await startMicrophone();
    connectWebSocket();
    await refreshImageGrid();
    await renderNotesBlock();
    await initMermaid();
  } catch (err) {
    console.error('Init failed:', err);
    setStatus('Mic access denied', false);
    appendArtifact('Error', `<p>${escapeHtml(err.message)}</p>`);
  }
}

init();
