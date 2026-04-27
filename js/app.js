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
  'langtons-ant':  './langton.js',
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let activeSim       = null;   // current simulation instance
let activeSimKey    = null;   // key into SIM_MODULES
let paused          = false;
let stepCount       = 0;
let lastFrameTime   = 0;
let fpsFrames       = 0;
let fpsAccum        = 0;
let fpsValue        = 0;

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

  // Render
  activeSim.render();
}

function formatStepCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
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

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ignore if user is typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  const simKeys = ['particle-life', 'boids', 'game-of-life', 'langtons-ant'];

  switch (e.key) {
    case '1': case '2': case '3': case '4': {
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

  // Load default simulation after boot finishes
  setTimeout(() => {
    loadSimulation('particle-life');
  }, 2700);
}

init();
