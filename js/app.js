/* ==========================================================================
   EMERGENCE — App Shell
   Orchestrates simulation loading, parameter UI, animation loop, and input.
   ========================================================================== */

// ---------------------------------------------------------------------------
// Module map — maps data-sim attribute values to ES module paths
// ---------------------------------------------------------------------------
const SIM_MODULES = {
  'particle-life': './particle-life.js',
  'boids':         './boids.js',
  'game-of-life':  './game-of-life.js',
  'langtons-ant':       './langton.js',
  'reaction-diffusion': './reaction-diffusion.js',
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const bootOverlay    = document.getElementById('boot-overlay');
const app            = document.getElementById('app');
const canvas         = document.getElementById('sim-canvas');
const ctx            = canvas.getContext('2d');
const paramsContainer = document.getElementById('params-container');
const fpsDisplay     = document.getElementById('fps-display');
const stepDisplay    = document.getElementById('step-display');
const btnReset       = document.getElementById('btn-reset');
const btnPause       = document.getElementById('btn-pause');
const simCards       = document.querySelectorAll('.sim-card');
const btnFullscreen  = document.getElementById('btn-fullscreen');
const btnScreenshot  = document.getElementById('btn-screenshot');
const sidebar        = document.getElementById('sidebar');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let activeSim       = null;   // current simulation instance
let activeSimKey    = null;   // key into SIM_MODULES
let paused          = false;
let isFullscreen    = false;
let stepCount       = 0;
let lastFrameTime   = 0;
let fpsFrames       = 0;
let fpsAccum        = 0;
let fpsValue        = 0;

// ---------------------------------------------------------------------------
// Ambient Audio System
// ---------------------------------------------------------------------------
const btnMute = document.getElementById('btn-mute');
let audioCtx       = null;
let audioStarted   = false;
let audioMuted     = true;   // start muted; user clicks to unmute
let masterGain     = null;
let droneOsc       = null;
let droneFilter    = null;
let harmonicOsc    = null;
let harmonicGain   = null;
let delayNode      = null;
let delayFeedback  = null;

/** Initialise the Web Audio graph (called once on first user interaction). */
function initAudio() {
  if (audioStarted) return;
  audioStarted = true;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // --- Master volume ---
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0; // start silent; toggled via mute button
  masterGain.connect(audioCtx.destination);

  // --- Delay (pseudo-reverb) ---
  delayNode = audioCtx.createDelay(1.0);
  delayNode.delayTime.value = 0.4;
  delayFeedback = audioCtx.createGain();
  delayFeedback.gain.value = 0.3;
  const delayFilter = audioCtx.createBiquadFilter();
  delayFilter.type = 'lowpass';
  delayFilter.frequency.value = 1200;
  delayNode.connect(delayFilter);
  delayFilter.connect(delayFeedback);
  delayFeedback.connect(delayNode);
  delayNode.connect(masterGain);

  // --- Drone layer: low sawtooth through lowpass ---
  droneOsc = audioCtx.createOscillator();
  droneOsc.type = 'sawtooth';
  droneOsc.frequency.value = 55; // A1
  droneFilter = audioCtx.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.value = 120;
  droneFilter.Q.value = 6;
  const droneGain = audioCtx.createGain();
  droneGain.gain.value = 0.6;
  droneOsc.connect(droneFilter);
  droneFilter.connect(droneGain);
  droneGain.connect(masterGain);
  droneGain.connect(delayNode);
  droneOsc.start();

  // --- Sub-bass sine to thicken the drone ---
  const subOsc = audioCtx.createOscillator();
  subOsc.type = 'sine';
  subOsc.frequency.value = 55;
  const subGain = audioCtx.createGain();
  subGain.gain.value = 0.4;
  subOsc.connect(subGain);
  subGain.connect(masterGain);
  subOsc.start();

  // --- Harmonic layer: slowly modulating sine ---
  harmonicOsc = audioCtx.createOscillator();
  harmonicOsc.type = 'sine';
  harmonicOsc.frequency.value = 220;
  harmonicGain = audioCtx.createGain();
  harmonicGain.gain.value = 0.0; // faded in by event triggers
  harmonicOsc.connect(harmonicGain);
  harmonicGain.connect(masterGain);
  harmonicGain.connect(delayNode);
  harmonicOsc.start();

  // --- Slow LFO on drone filter cutoff for movement ---
  const lfo = audioCtx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 0.08; // very slow
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 40;
  lfo.connect(lfoGain);
  lfoGain.connect(droneFilter.frequency);
  lfo.start();

  // --- Slow pitch drift on drone for organic feel ---
  const driftLfo = audioCtx.createOscillator();
  driftLfo.type = 'sine';
  driftLfo.frequency.value = 0.03;
  const driftGain = audioCtx.createGain();
  driftGain.gain.value = 2; // +/- 2 Hz
  driftLfo.connect(driftGain);
  driftGain.connect(droneOsc.frequency);
  driftGain.connect(subOsc.frequency);
  driftLfo.start();
}

/** Trigger a brief harmonic tone — called on simulation events. */
function triggerHarmonicPing() {
  if (!audioCtx || audioMuted) return;
  const now = audioCtx.currentTime;
  // Pick a random overtone of the drone fundamental
  const harmonics = [110, 165, 220, 330, 440];
  const freq = harmonics[Math.floor(Math.random() * harmonics.length)];
  harmonicOsc.frequency.setValueAtTime(freq, now);
  harmonicGain.gain.cancelScheduledValues(now);
  harmonicGain.gain.setValueAtTime(0.15, now);
  harmonicGain.gain.exponentialRampToValueAtTime(0.001, now + 2.5);
}

/** Modulate drone based on simulation tempo (stepCount). */
function modulateDrone() {
  if (!audioCtx || !droneFilter) return;
  // Subtly shift filter cutoff based on recent step count parity
  const target = 100 + (stepCount % 200) * 0.2;
  droneFilter.frequency.linearRampToValueAtTime(target, audioCtx.currentTime + 0.5);
}

/** Toggle mute / unmute. */
function toggleMute() {
  initAudio(); // ensure audio context exists
  audioMuted = !audioMuted;
  const now = audioCtx.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  if (audioMuted) {
    masterGain.gain.linearRampToValueAtTime(0, now + 0.3);
    btnMute.textContent = '\u{1F507}';
    btnMute.classList.remove('unmuted');
  } else {
    // Resume context if suspended (autoplay policy)
    if (audioCtx.state === 'suspended') audioCtx.resume();
    masterGain.gain.linearRampToValueAtTime(0.07, now + 0.5);
    btnMute.textContent = '\u{1F50A}';
    btnMute.classList.add('unmuted');
  }
}

// ---------------------------------------------------------------------------
// Boot Sequence
// ---------------------------------------------------------------------------
function runBootSequence() {
  const lines = bootOverlay.querySelectorAll('.boot-line');
  lines.forEach(line => {
    const delay = parseInt(line.dataset.delay, 10) || 0;
    setTimeout(() => line.classList.add('visible'), delay);
  });

  // Fade out overlay, reveal app
  const totalBoot = 2600;
  setTimeout(() => {
    bootOverlay.classList.add('fade-out');
    app.classList.remove('hidden');
  }, totalBoot);

  // Remove overlay from DOM after transition
  setTimeout(() => {
    bootOverlay.remove();
  }, totalBoot + 700);
}

// ---------------------------------------------------------------------------
// Canvas Sizing
// ---------------------------------------------------------------------------
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width  = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (activeSim) {
    activeSim.handleResize(rect.width, rect.height);
  }
}

// Use ResizeObserver for the canvas area
const resizeObserver = new ResizeObserver(() => resizeCanvas());

// ---------------------------------------------------------------------------
// Simulation Loading
// ---------------------------------------------------------------------------
async function loadSimulation(key) {
  // Destroy previous
  if (activeSim) {
    try { activeSim.destroy(); } catch (_) { /* ignore */ }
    activeSim = null;
  }

  activeSimKey = key;
  stepCount = 0;
  stepDisplay.textContent = '0';

  // Dynamic import
  const module = await import(SIM_MODULES[key]);
  const SimClass = module.default;

  // Instantiate
  const rect = canvas.parentElement.getBoundingClientRect();
  activeSim = new SimClass(canvas, ctx);
  activeSim.handleResize(rect.width, rect.height);
  activeSim.init();

  // Build parameter UI
  buildParamsUI();

  // Update selector active state
  simCards.forEach(card => {
    card.classList.toggle('active', card.dataset.sim === key);
  });

  // Trigger ambient audio event on sim switch
  triggerHarmonicPing();

  // Update URL hash
  updateURLHash();
}

// ---------------------------------------------------------------------------
// Parameter UI Generation
// ---------------------------------------------------------------------------
function buildParamsUI() {
  paramsContainer.innerHTML = '';

  if (!activeSim) return;

  const params = activeSim.getParams();
  if (!params || params.length === 0) {
    paramsContainer.innerHTML = '<p style="color:var(--text-dim);font-size:12px;">No adjustable parameters.</p>';
    return;
  }

  params.forEach(p => {
    switch (p.type) {
      case 'range':
        paramsContainer.appendChild(createRangeControl(p));
        break;
      case 'checkbox':
        paramsContainer.appendChild(createToggleControl(p));
        break;
      case 'color':
        paramsContainer.appendChild(createColorControl(p));
        break;
      case 'select':
        paramsContainer.appendChild(createSelectControl(p));
        break;
      default:
        break;
    }
  });
}

function createRangeControl(p) {
  const group = document.createElement('div');
  group.className = 'param-group';

  const header = document.createElement('div');
  header.className = 'param-header';

  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = p.label;

  const value = document.createElement('span');
  value.className = 'param-value';
  value.textContent = formatNumber(p.value, p.step);

  header.append(label, value);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = p.min ?? 0;
  input.max = p.max ?? 100;
  input.step = p.step ?? 1;
  input.value = p.value;

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    value.textContent = formatNumber(v, p.step);
    if (activeSim) activeSim.setParam(p.name, v);
    updateURLHash();
  });

  group.append(header, input);
  return group;
}

function createToggleControl(p) {
  const group = document.createElement('label');
  group.className = 'param-group param-toggle';

  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = p.label;

  const toggle = document.createElement('div');
  toggle.className = 'toggle-switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!p.value;

  const track = document.createElement('span');
  track.className = 'toggle-track';

  input.addEventListener('change', () => {
    if (activeSim) activeSim.setParam(p.name, input.checked);
    updateURLHash();
  });

  toggle.append(input, track);
  group.append(label, toggle);
  return group;
}

function createColorControl(p) {
  const group = document.createElement('div');
  group.className = 'param-group param-color';

  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = p.label;

  const wrap = document.createElement('div');
  wrap.className = 'color-picker-wrap';

  const input = document.createElement('input');
  input.type = 'color';
  input.value = p.value || '#00f5d4';

  input.addEventListener('input', () => {
    if (activeSim) activeSim.setParam(p.name, input.value);
    updateURLHash();
  });

  wrap.appendChild(input);
  group.append(label, wrap);
  return group;
}

function createSelectControl(p) {
  const group = document.createElement('div');
  group.className = 'param-group';

  const header = document.createElement('div');
  header.className = 'param-header';

  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = p.label;

  header.appendChild(label);

  const select = document.createElement('select');
  select.className = 'param-select';

  const options = p.options || [];
  const labels = p.optionLabels || options;
  options.forEach((opt, i) => {
    const option = document.createElement('option');
    option.value = opt;
    option.textContent = labels[i] || opt;
    if (opt === p.value) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (activeSim) activeSim.setParam(p.name, select.value);
    updateURLHash();
  });

  group.append(header, select);
  return group;
}

function formatNumber(val, step) {
  if (step != null && step < 1) {
    // Determine decimal places from step
    const decimals = String(step).split('.')[1]?.length || 2;
    return Number(val).toFixed(decimals);
  }
  return String(Math.round(val));
}

// ---------------------------------------------------------------------------
// Animation Loop
// ---------------------------------------------------------------------------
function loop(timestamp) {
  requestAnimationFrame(loop);

  if (!lastFrameTime) lastFrameTime = timestamp;
  const dt = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  // FPS calculation (update once per second)
  fpsFrames++;
  fpsAccum += dt;
  if (fpsAccum >= 1000) {
    fpsValue = Math.round((fpsFrames * 1000) / fpsAccum);
    fpsDisplay.textContent = fpsValue;
    fpsFrames = 0;
    fpsAccum = 0;
  }

  if (!activeSim || paused) return;

  // Update
  activeSim.update(dt);
  stepCount++;
  stepDisplay.textContent = formatStepCount(stepCount);

  // Ambient audio — modulate drone & trigger occasional harmonic pings
  if (audioStarted && !audioMuted) {
    modulateDrone();
    // Trigger a harmonic ping roughly every 3-6 seconds (random)
    if (stepCount % 200 === 0 && Math.random() < 0.35) {
      triggerHarmonicPing();
    }
  }

  // Render
  activeSim.render();
}

function formatStepCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ---------------------------------------------------------------------------
// URL State Persistence
// ---------------------------------------------------------------------------
let hashUpdateTimer = null;

/** Build a hash string from the current sim key and its parameters. */
function buildHashFromState() {
  if (!activeSimKey) return '';
  const parts = [`sim=${activeSimKey}`];
  if (activeSim) {
    const params = activeSim.getParams();
    if (params) {
      params.forEach(p => {
        parts.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`);
      });
    }
  }
  return '#' + parts.join('&');
}

/** Push the current state into the URL hash (debounced). */
function updateURLHash() {
  clearTimeout(hashUpdateTimer);
  hashUpdateTimer = setTimeout(() => {
    const hash = buildHashFromState();
    if (hash && window.location.hash !== hash) {
      history.replaceState(null, '', hash);
    }
  }, 300);
}

/** Parse the URL hash and return { sim, params } or null. */
function parseURLHash() {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  const pairs = hash.slice(1).split('&');
  const result = { sim: null, params: {} };
  pairs.forEach(pair => {
    const [k, v] = pair.split('=').map(decodeURIComponent);
    if (k === 'sim') {
      result.sim = v;
    } else if (k && v !== undefined) {
      result.params[k] = v;
    }
  });
  return result.sim ? result : null;
}

/** Apply URL hash params to the active simulation after loading. */
function applyHashParams(paramMap) {
  if (!activeSim || !paramMap) return;
  const params = activeSim.getParams();
  if (!params) return;
  params.forEach(p => {
    if (paramMap[p.name] !== undefined) {
      let val;
      if (p.type === 'checkbox') {
        val = paramMap[p.name] === 'true';
      } else if (p.type === 'range') {
        val = parseFloat(paramMap[p.name]);
        if (isNaN(val)) return;
      } else {
        val = paramMap[p.name];
      }
      activeSim.setParam(p.name, val);
    }
  });
  // Rebuild UI to reflect restored values
  buildParamsUI();
}

// ---------------------------------------------------------------------------
// Fullscreen Mode
// ---------------------------------------------------------------------------
function toggleFullscreen() {
  isFullscreen = !isFullscreen;
  app.classList.toggle('fullscreen', isFullscreen);
  btnFullscreen.classList.toggle('active', isFullscreen);
  // Trigger resize after transition completes
  setTimeout(() => resizeCanvas(), 400);
}

// ---------------------------------------------------------------------------
// Screenshot Export
// ---------------------------------------------------------------------------
function exportScreenshot() {
  if (!canvas) return;
  const dataURL = canvas.toDataURL('image/png');
  const link = document.createElement('a');
  const simName = activeSimKey || 'simulation';
  const today = new Date().toISOString().slice(0, 10);
  link.download = `emergence-${simName}-${today}.png`;
  link.href = dataURL;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

// Simulation card clicks
simCards.forEach(card => {
  card.addEventListener('click', () => {
    const key = card.dataset.sim;
    if (key === activeSimKey) return;
    paused = false;
    btnPause.textContent = 'Pause';
    btnPause.classList.remove('paused');
    loadSimulation(key);
  });
});

// Reset button
btnReset.addEventListener('click', () => {
  if (!activeSim) return;
  activeSim.reset();
  stepCount = 0;
  stepDisplay.textContent = '0';
  buildParamsUI();
});

// Pause button
btnPause.addEventListener('click', () => {
  paused = !paused;
  btnPause.textContent = paused ? 'Resume' : 'Pause';
  btnPause.classList.toggle('paused', paused);
});

// Mute button
btnMute.addEventListener('click', () => {
  toggleMute();
});

// Fullscreen button
btnFullscreen.addEventListener('click', () => {
  toggleFullscreen();
});

// Screenshot button
btnScreenshot.addEventListener('click', () => {
  exportScreenshot();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ignore if user is typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  const simKeys = ['particle-life', 'boids', 'game-of-life', 'langtons-ant', 'reaction-diffusion'];

  switch (e.key) {
    case '1': case '2': case '3': case '4': case '5': {
      const idx = parseInt(e.key, 10) - 1;
      const key = simKeys[idx];
      if (key && key !== activeSimKey) {
        paused = false;
        btnPause.textContent = 'Pause';
        btnPause.classList.remove('paused');
        loadSimulation(key);
      }
      break;
    }
    case ' ':
      e.preventDefault();
      paused = !paused;
      btnPause.textContent = paused ? 'Resume' : 'Pause';
      btnPause.classList.toggle('paused', paused);
      break;
    case 'r':
    case 'R':
      if (!e.ctrlKey && !e.metaKey && activeSim) {
        activeSim.reset();
        stepCount = 0;
        stepDisplay.textContent = '0';
        buildParamsUI();
      }
      break;
    case 'm':
    case 'M':
      toggleMute();
      break;
    case 'f':
    case 'F':
      if (!e.ctrlKey && !e.metaKey) {
        toggleFullscreen();
      }
      break;
    case 'Escape':
      if (isFullscreen) {
        toggleFullscreen();
      }
      break;
  }
});

// Canvas click → pass to simulation
canvas.addEventListener('click', (e) => {
  if (!activeSim) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  activeSim.handleClick(x, y, e);
});

// Prevent context menu on canvas for right-click interactions
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!activeSim) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  activeSim.handleClick(x, y, e);
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
function init() {
  // Boot sequence
  runBootSequence();

  // Setup canvas sizing
  resizeObserver.observe(document.getElementById('canvas-area'));
  resizeCanvas();

  // Start animation loop
  requestAnimationFrame(loop);

  // Load simulation after boot finishes — restore from URL hash if present
  const hashState = parseURLHash();
  const initialSim = (hashState && SIM_MODULES[hashState.sim]) ? hashState.sim : 'particle-life';
  setTimeout(async () => {
    await loadSimulation(initialSim);
    // Apply hash params after sim is loaded
    if (hashState && hashState.sim === initialSim) {
      applyHashParams(hashState.params);
    }
  }, 2700);
}

init();
