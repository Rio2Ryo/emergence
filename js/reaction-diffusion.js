// ============================================================================
// Reaction-Diffusion (Gray-Scott Model) — Emergence Artificial Life Laboratory
// ============================================================================
// Simulates two chemicals (U and V) that diffuse and react, producing organic
// patterns: spots, stripes, coral, mitosis, spirals, and worms.
//
// Gray-Scott equations:
//   dU/dt = Du * laplacian(U) - U*V^2 + f*(1-U)
//   dV/dt = Dv * laplacian(V) + U*V^2 - (f+k)*V
// ============================================================================

// ---------------------------------------------------------------------------
// Presets — (f, k) pairs that produce dramatically different patterns
// ---------------------------------------------------------------------------
const PRESETS = {
  mitosis:  { f: 0.0367, k: 0.0649, label: 'Mitosis'  },
  coral:    { f: 0.0545, k: 0.062,  label: 'Coral'    },
  spirals:  { f: 0.014,  k: 0.054,  label: 'Spirals'  },
  spots:    { f: 0.03,   k: 0.062,  label: 'Spots'    },
  stripes:  { f: 0.022,  k: 0.051,  label: 'Stripes'  },
  worms:    { f: 0.058,  k: 0.065,  label: 'Worms'    },
};

// ---------------------------------------------------------------------------
// Color palettes — map V concentration [0..1] to RGB
// ---------------------------------------------------------------------------
// Each palette is a list of stops: { t, r, g, b } where t in [0, 1].
const PALETTES = {
  ocean: [
    { t: 0.00, r: 10,  g: 10,  b: 46  },  // deep ocean blue  #0a0a2e
    { t: 0.20, r: 5,   g: 30,  b: 80  },
    { t: 0.40, r: 0,   g: 140, b: 180 },
    { t: 0.55, r: 0,   g: 245, b: 212 },  // cyan/teal        #00f5d4
    { t: 0.70, r: 160, g: 0,   b: 200 },
    { t: 0.85, r: 255, g: 0,   b: 110 },  // bright magenta   #ff006e
    { t: 1.00, r: 255, g: 255, b: 255 },  // white
  ],
  fire: [
    { t: 0.00, r: 10,  g: 5,   b: 5   },
    { t: 0.20, r: 40,  g: 5,   b: 0   },
    { t: 0.40, r: 150, g: 20,  b: 0   },
    { t: 0.55, r: 230, g: 60,  b: 0   },
    { t: 0.70, r: 255, g: 160, b: 20  },
    { t: 0.85, r: 255, g: 230, b: 80  },
    { t: 1.00, r: 255, g: 255, b: 240 },
  ],
  mono: [
    { t: 0.00, r: 10,  g: 10,  b: 15  },
    { t: 0.30, r: 40,  g: 42,  b: 54  },
    { t: 0.50, r: 100, g: 105, b: 120 },
    { t: 0.70, r: 170, g: 175, b: 190 },
    { t: 1.00, r: 240, g: 245, b: 255 },
  ],
};

// Build a 256-entry lookup table from a palette for fast per-pixel color mapping.
function buildColorLUT(palette) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // Find the two surrounding stops.
    let lo = palette[0];
    let hi = palette[palette.length - 1];
    for (let s = 1; s < palette.length; s++) {
      if (t <= palette[s].t) {
        lo = palette[s - 1];
        hi = palette[s];
        break;
      }
    }
    const range = hi.t - lo.t;
    const frac = range > 0 ? (t - lo.t) / range : 0;
    const idx = i * 3;
    lut[idx]     = lo.r + (hi.r - lo.r) * frac | 0;
    lut[idx + 1] = lo.g + (hi.g - lo.g) * frac | 0;
    lut[idx + 2] = lo.b + (hi.b - lo.b) * frac | 0;
  }
  return lut;
}

// Pre-build all LUTs.
const COLOR_LUTS = {};
for (const key of Object.keys(PALETTES)) {
  COLOR_LUTS[key] = buildColorLUT(PALETTES[key]);
}

// ============================================================================
// Main class
// ============================================================================

export default class ReactionDiffusion {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.running = false;

    // Parameters with defaults (Mitosis preset)
    this.params = {
      preset: 'mitosis',
      feedRate: 0.0367,
      killRate: 0.0649,
      diffusionU: 0.21,
      diffusionV: 0.105,
      stepsPerFrame: 8,
      colorMode: 'ocean',
    };

    // Grid dimensions (half canvas resolution for performance)
    this.gridW = 0;
    this.gridH = 0;
    this.scale = 2; // each cell = scale x scale pixels

    // Chemical concentration grids (double-buffered)
    this.u = null;   // Float32Array — chemical U (substrate)
    this.v = null;   // Float32Array — chemical V (catalyst)
    this.nextU = null;
    this.nextV = null;

    // Rendering buffer
    this.imageData = null;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  init() {
    this._allocateGrid();
    this._seedInitial();
  }

  reset() {
    this._allocateGrid();
    this._seedInitial();
  }

  destroy() {
    this.u = null;
    this.v = null;
    this.nextU = null;
    this.nextV = null;
    this.imageData = null;
    this._stagingCanvas = null;
    this._stagingCtx = null;
  }

  // --------------------------------------------------------------------------
  // Grid allocation
  // --------------------------------------------------------------------------

  _allocateGrid() {
    this.gridW = Math.floor(this.canvas.width / this.scale);
    this.gridH = Math.floor(this.canvas.height / this.scale);
    const len = this.gridW * this.gridH;

    this.u = new Float32Array(len);
    this.v = new Float32Array(len);
    this.nextU = new Float32Array(len);
    this.nextV = new Float32Array(len);

    // Initialize U=1 everywhere, V=0 everywhere (uniform substrate, no catalyst)
    this.u.fill(1.0);
    this.v.fill(0.0);

    // Staging canvas for putImageData → drawImage scaling pipeline.
    // putImageData ignores canvas transforms, so we render to a small
    // offscreen canvas first, then drawImage it scaled onto the main canvas.
    if (!this._stagingCanvas) {
      this._stagingCanvas = document.createElement('canvas');
      this._stagingCtx = this._stagingCanvas.getContext('2d');
    }
    this._stagingCanvas.width = this.gridW;
    this._stagingCanvas.height = this.gridH;

    // Create ImageData at grid resolution
    this.imageData = this._stagingCtx.createImageData(this.gridW, this.gridH);
  }

  // --------------------------------------------------------------------------
  // Seeding — place initial spots of chemical V
  // --------------------------------------------------------------------------

  _seedInitial() {
    const numSeeds = 12 + Math.floor(Math.random() * 8);
    for (let i = 0; i < numSeeds; i++) {
      const cx = Math.floor(Math.random() * this.gridW);
      const cy = Math.floor(Math.random() * this.gridH);
      this._seedSpot(cx, cy, 5 + Math.floor(Math.random() * 6));
    }
  }

  _seedSpot(cx, cy, radius) {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        // Wrap toroidally
        let x = ((cx + dx) % this.gridW + this.gridW) % this.gridW;
        let y = ((cy + dy) % this.gridH + this.gridH) % this.gridH;
        const idx = y * this.gridW + x;
        this.u[idx] = 0.5;
        this.v[idx] = 0.25;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Simulation step — Gray-Scott with 9-point Laplacian stencil
  // --------------------------------------------------------------------------

  update(dt) {
    const steps = this.params.stepsPerFrame;
    for (let s = 0; s < steps; s++) {
      this._step();
    }
  }

  _step() {
    const { gridW: w, gridH: h, u, v, nextU, nextV, params } = this;
    const Du = params.diffusionU;
    const Dv = params.diffusionV;
    const f = params.feedRate;
    const k = params.killRate;
    const dt = 1.0; // simulation timestep

    // 9-point Laplacian weights:
    //   [0.05  0.2  0.05]
    //   [0.2  -1.0  0.2 ]
    //   [0.05  0.2  0.05]
    // Sum of positive weights = 1.0, center = -1.0

    for (let y = 0; y < h; y++) {
      // Wrap row indices
      const ym1 = y === 0 ? h - 1 : y - 1;
      const yp1 = y === h - 1 ? 0 : y + 1;
      const rowOff   = y   * w;
      const rowUp    = ym1 * w;
      const rowDown  = yp1 * w;

      for (let x = 0; x < w; x++) {
        // Wrap column indices
        const xm1 = x === 0 ? w - 1 : x - 1;
        const xp1 = x === w - 1 ? 0 : x + 1;

        const idx = rowOff + x;
        const uVal = u[idx];
        const vVal = v[idx];

        // 9-point Laplacian for U
        const lapU =
          0.05 * u[rowUp   + xm1] +
          0.20 * u[rowUp   + x  ] +
          0.05 * u[rowUp   + xp1] +
          0.20 * u[rowOff  + xm1] +
         -1.00 * uVal +
          0.20 * u[rowOff  + xp1] +
          0.05 * u[rowDown + xm1] +
          0.20 * u[rowDown + x  ] +
          0.05 * u[rowDown + xp1];

        // 9-point Laplacian for V
        const lapV =
          0.05 * v[rowUp   + xm1] +
          0.20 * v[rowUp   + x  ] +
          0.05 * v[rowUp   + xp1] +
          0.20 * v[rowOff  + xm1] +
         -1.00 * vVal +
          0.20 * v[rowOff  + xp1] +
          0.05 * v[rowDown + xm1] +
          0.20 * v[rowDown + x  ] +
          0.05 * v[rowDown + xp1];

        // Reaction term
        const uvv = uVal * vVal * vVal;

        // Gray-Scott update
        nextU[idx] = uVal + dt * (Du * lapU - uvv + f * (1.0 - uVal));
        nextV[idx] = vVal + dt * (Dv * lapV + uvv - (f + k) * vVal);
      }
    }

    // Swap buffers
    this.u = nextU;
    this.v = nextV;
    this.nextU = u;
    this.nextV = v;
  }

  // --------------------------------------------------------------------------
  // Rendering — map V concentration to color via LUT, output to ImageData
  // --------------------------------------------------------------------------

  render() {
    const { ctx, canvas, gridW: w, gridH: h, v, imageData, params } = this;
    const colorLUT = COLOR_LUTS[params.colorMode] || COLOR_LUTS.ocean;
    const pixels = imageData.data;

    for (let i = 0, len = w * h; i < len; i++) {
      // Clamp V to [0, 1] and map to 0..255 index into the color LUT
      let vClamped = v[i];
      if (vClamped < 0) vClamped = 0;
      if (vClamped > 1) vClamped = 1;
      const ci = (vClamped * 255 + 0.5) | 0;  // round to nearest
      const lutIdx = ci * 3;

      const pi = i * 4;
      pixels[pi]     = colorLUT[lutIdx];
      pixels[pi + 1] = colorLUT[lutIdx + 1];
      pixels[pi + 2] = colorLUT[lutIdx + 2];
      pixels[pi + 3] = 255;
    }

    // Write small imageData to the offscreen staging canvas
    this._stagingCtx.putImageData(imageData, 0, 0);

    // Reset the main canvas transform so we can draw in raw pixel coords,
    // then scale the staging canvas up to fill the full physical canvas.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this._stagingCanvas,
      0, 0, w, h,
      0, 0, canvas.width, canvas.height
    );
    ctx.restore();
  }

  // --------------------------------------------------------------------------
  // Interaction — click to seed a spot of chemical V
  // --------------------------------------------------------------------------

  handleClick(x, y) {
    // x, y are CSS coordinates from the app shell.
    // The canvas CSS size is canvas.width/dpr x canvas.height/dpr.
    // The grid maps to the full CSS area, so grid coords = CSS coords / CSS size * gridDim.
    const rect = this.canvas.getBoundingClientRect();
    const gx = Math.floor((x / rect.width) * this.gridW);
    const gy = Math.floor((y / rect.height) * this.gridH);
    const radius = 5 + Math.floor(Math.random() * 5);
    this._seedSpot(gx, gy, radius);
  }

  handleResize(width, height) {
    // Store current state
    const oldW = this.gridW;
    const oldH = this.gridH;
    const oldU = this.u;
    const oldV = this.v;

    // Recalculate grid
    this.gridW = Math.floor(this.canvas.width / this.scale);
    this.gridH = Math.floor(this.canvas.height / this.scale);
    const len = this.gridW * this.gridH;

    this.u = new Float32Array(len);
    this.v = new Float32Array(len);
    this.nextU = new Float32Array(len);
    this.nextV = new Float32Array(len);

    // Fill with substrate
    this.u.fill(1.0);
    this.v.fill(0.0);

    // Copy existing data where possible
    if (oldU && oldV) {
      const copyW = Math.min(oldW, this.gridW);
      const copyH = Math.min(oldH, this.gridH);
      for (let y = 0; y < copyH; y++) {
        for (let x = 0; x < copyW; x++) {
          const ni = y * this.gridW + x;
          const oi = y * oldW + x;
          this.u[ni] = oldU[oi];
          this.v[ni] = oldV[oi];
        }
      }
    }

    // Resize staging canvas and recreate ImageData
    if (!this._stagingCanvas) {
      this._stagingCanvas = document.createElement('canvas');
      this._stagingCtx = this._stagingCanvas.getContext('2d');
    }
    this._stagingCanvas.width = this.gridW;
    this._stagingCanvas.height = this.gridH;
    this.imageData = this._stagingCtx.createImageData(this.gridW, this.gridH);
  }

  // --------------------------------------------------------------------------
  // Parameters
  // --------------------------------------------------------------------------

  getParams() {
    return [
      {
        name: 'preset',
        label: 'Pattern Preset',
        type: 'select',
        options: Object.keys(PRESETS),
        optionLabels: Object.values(PRESETS).map(p => p.label),
        value: this.params.preset,
      },
      {
        name: 'feedRate',
        label: 'Feed Rate (f)',
        type: 'range',
        min: 0.01,
        max: 0.08,
        step: 0.001,
        value: this.params.feedRate,
      },
      {
        name: 'killRate',
        label: 'Kill Rate (k)',
        type: 'range',
        min: 0.04,
        max: 0.07,
        step: 0.001,
        value: this.params.killRate,
      },
      {
        name: 'diffusionU',
        label: 'Diffusion U',
        type: 'range',
        min: 0.1,
        max: 0.3,
        step: 0.01,
        value: this.params.diffusionU,
      },
      {
        name: 'diffusionV',
        label: 'Diffusion V',
        type: 'range',
        min: 0.05,
        max: 0.15,
        step: 0.005,
        value: this.params.diffusionV,
      },
      {
        name: 'stepsPerFrame',
        label: 'Steps / Frame',
        type: 'range',
        min: 1,
        max: 20,
        step: 1,
        value: this.params.stepsPerFrame,
      },
      {
        name: 'colorMode',
        label: 'Color Mode',
        type: 'select',
        options: ['ocean', 'fire', 'mono'],
        optionLabels: ['Ocean', 'Fire', 'Mono'],
        value: this.params.colorMode,
      },
    ];
  }

  setParam(name, value) {
    switch (name) {
      case 'preset': {
        const p = PRESETS[value];
        if (p) {
          this.params.preset = value;
          this.params.feedRate = p.f;
          this.params.killRate = p.k;
        }
        break;
      }
      case 'feedRate':
        this.params.feedRate = Math.max(0.01, Math.min(0.08, +value));
        break;
      case 'killRate':
        this.params.killRate = Math.max(0.04, Math.min(0.07, +value));
        break;
      case 'diffusionU':
        this.params.diffusionU = Math.max(0.1, Math.min(0.3, +value));
        break;
      case 'diffusionV':
        this.params.diffusionV = Math.max(0.05, Math.min(0.15, +value));
        break;
      case 'stepsPerFrame':
        this.params.stepsPerFrame = Math.max(1, Math.min(20, Math.round(+value)));
        break;
      case 'colorMode':
        if (PALETTES[value]) {
          this.params.colorMode = value;
        }
        break;
    }
  }
}
