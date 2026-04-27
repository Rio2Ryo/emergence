// ============================================================================
// Langton's Ant — Emergence: Interactive Artificial Life Laboratory
// ============================================================================
// Classic Langton's Ant with multi-ant support, extended rulesets (LLRR, etc.),
// multi-state cells, dirty-rectangle rendering via offscreen ImageData, and
// smooth auto-zoom to keep the full pattern in view.
// ============================================================================

// Direction vectors: 0=Up, 1=Right, 2=Down, 3=Left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// Preset rule definitions
const PRESETS = {
  Classic: 'RL',
  Square: 'LLRR',
  Triangle: 'LRRRRRLLR',
  Chaos: 'RRLLLRLLLRRR',
};

/**
 * Generate a palette of N colors as [r, g, b] arrays.
 * Traverses: black -> indigo -> violet -> magenta -> orange -> yellow -> white
 */
function generatePalette(n) {
  const stops = [
    [10, 10, 15],     // near-black (background)
    [30, 10, 80],     // deep indigo
    [75, 0, 130],     // indigo
    [138, 43, 226],   // violet
    [199, 21, 133],   // magenta
    [255, 69, 0],     // orange-red
    [255, 140, 0],    // orange
    [255, 215, 0],    // gold / yellow
    [255, 255, 240],  // near-white
  ];

  if (n === 1) return [[10, 10, 15]];
  if (n === 2) return [[10, 10, 15], [138, 43, 226]];

  const palette = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const pos = t * (stops.length - 1);
    const idx = Math.min(Math.floor(pos), stops.length - 2);
    const frac = pos - idx;
    const a = stops[idx];
    const b = stops[idx + 1];
    palette.push([
      Math.round(a[0] + (b[0] - a[0]) * frac),
      Math.round(a[1] + (b[1] - a[1]) * frac),
      Math.round(a[2] + (b[2] - a[2]) * frac),
    ]);
  }
  return palette;
}

// Distinct hues for each ant so they are visually separable
const ANT_COLORS = [
  '#00ffcc', '#ff3366', '#33ccff', '#ffcc00',
  '#cc66ff', '#66ff33', '#ff6633', '#33ffcc',
];

export default class LangtonsAnt {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.running = false;

    // Params with defaults
    this.params = {
      cellSize: 3,
      stepsPerFrame: 10,
      antCount: 1,
      ruleString: 'RL',
      showAnts: true,
      zoomToFit: true,
    };

    // Internal state — populated in init()
    this.grid = null;         // Uint8Array — cell states
    this.gridW = 0;
    this.gridH = 0;
    this.ants = [];
    this.stepCount = 0;
    this.palette = [];        // [[r,g,b], ...]
    this.paletteCSS = [];     // ['rgb(r,g,b)', ...]
    this.paletteFlat = null;  // Uint8Array [r0,g0,b0, r1,g1,b1, ...] for ImageData writes
    this.ruleChars = null;    // Uint8Array — parsed rule: 0=R, 1=L
    this.numStates = 0;

    // Offscreen pixel buffer (1 pixel per cell)
    this.imgData = null;      // ImageData (gridW x gridH)
    this.pixels = null;       // Uint32Array view of imgData.data

    // Dirty cell list for incremental pixel updates
    this._dirtyCells = null;  // Int32Array ring buffer
    this._dirtyCount = 0;

    // Zoom / pan state (smoothly animated)
    this.viewScale = 1;
    this.viewOffsetX = 0;
    this.viewOffsetY = 0;
    this._targetScale = 1;
    this._targetOX = 0;
    this._targetOY = 0;

    // Bounding box of all visited cells (for zoom-to-fit)
    this.visitedMinX = Infinity;
    this.visitedMinY = Infinity;
    this.visitedMaxX = -Infinity;
    this.visitedMaxY = -Infinity;

    // Offscreen canvas for compositing the cell image
    this._offCanvas = null;
    this._offCtx = null;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  init() {
    this._parseRule(this.params.ruleString);
    this._allocateGrid();
    this._placeAnts(this.params.antCount);
    this.stepCount = 0;
    this._resetVisitedBounds();
    this._initImageBuffer();
    this._initOffscreenCanvas();

    // Set initial view to center of grid
    this.viewScale = 1;
    this._targetScale = 1;
    const cs = this.params.cellSize;
    this.viewOffsetX = (this.canvas.width - this.gridW * cs) / 2;
    this.viewOffsetY = (this.canvas.height - this.gridH * cs) / 2;
    this._targetOX = this.viewOffsetX;
    this._targetOY = this.viewOffsetY;
  }

  reset() {
    this.init();
  }

  destroy() {
    this.grid = null;
    this.imgData = null;
    this.pixels = null;
    this._dirtyCells = null;
    this._offCanvas = null;
    this._offCtx = null;
  }

  // --------------------------------------------------------------------------
  // Parameters
  // --------------------------------------------------------------------------

  getParams() {
    return [
      {
        name: 'cellSize',
        label: 'Cell Size',
        type: 'range',
        min: 1, max: 10, step: 1,
        value: this.params.cellSize,
      },
      {
        name: 'stepsPerFrame',
        label: 'Steps / Frame',
        type: 'range',
        min: 1, max: 500, step: 1,
        value: this.params.stepsPerFrame,
      },
      {
        name: 'antCount',
        label: 'Ant Count',
        type: 'range',
        min: 1, max: 8, step: 1,
        value: this.params.antCount,
      },
      {
        name: 'ruleString',
        label: 'Rule',
        type: 'select',
        options: ['RL', 'LLRR', 'LRRRRRLLR', 'RRLLLRLLLRRR'],
        optionLabels: ['Classic (RL)', 'Square (LLRR)', 'Triangle (LRRRRRLLR)', 'Chaos (RRLLLRLLLRRR)'],
        value: this.params.ruleString,
      },
      {
        name: 'showAnts',
        label: 'Show Ants',
        type: 'checkbox',
        value: this.params.showAnts,
      },
      {
        name: 'zoomToFit',
        label: 'Zoom to Fit',
        type: 'checkbox',
        value: this.params.zoomToFit,
      },
    ];
  }

  setParam(name, value) {
    const prev = this.params[name];
    this.params[name] = value;

    switch (name) {
      case 'cellSize':
        this.params.cellSize = Math.max(1, Math.min(10, Number(value)));
        break;

      case 'stepsPerFrame':
        this.params.stepsPerFrame = Math.max(1, Math.min(500, Number(value)));
        break;

      case 'antCount': {
        const count = Math.max(1, Math.min(8, Number(value)));
        this.params.antCount = count;
        while (this.ants.length < count) {
          this._addAntAtCenter(this.ants.length);
        }
        while (this.ants.length > count) {
          this.ants.pop();
        }
        break;
      }

      case 'ruleString':
        if (value !== prev) {
          this.params.ruleString = value;
          this.init();
        }
        break;

      case 'showAnts':
        this.params.showAnts = !!value;
        break;

      case 'zoomToFit':
        this.params.zoomToFit = !!value;
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Simulation update
  // --------------------------------------------------------------------------

  update(_dt) {
    const steps = this.params.stepsPerFrame;
    const { grid, gridW, gridH, ruleChars, numStates, pixels, paletteFlat } = this;
    const ants = this.ants;
    const antLen = ants.length;

    // Pre-compute RGBA palette as Uint32 for direct pixel writes
    // (computed once, cached)
    if (!this._palette32) {
      this._buildPalette32();
    }
    const palette32 = this._palette32;

    // Reset dirty tracking for this frame
    this._dirtyCount = 0;
    const dirtyCells = this._dirtyCells;

    for (let s = 0; s < steps; s++) {
      for (let a = 0; a < antLen; a++) {
        const ant = ants[a];
        const x = ant.x;
        const y = ant.y;

        // Bounds check
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;

        const idx = y * gridW + x;
        const state = grid[idx];

        // Turn
        let dir = ant.dir;
        if (ruleChars[state] === 0) {
          dir = (dir + 1) & 3; // R
        } else {
          dir = (dir + 3) & 3; // L
        }

        // Flip cell state
        const newState = (state + 1) % numStates;
        grid[idx] = newState;

        // Update pixel buffer directly
        pixels[idx] = palette32[newState];

        // Track dirty cell (for potential partial blit — but we blit full image)
        // We skip tracking individual dirty cells since we blit the entire
        // offscreen image each frame anyway. Instead, track visited bounds.

        // Update visited bounds
        if (x < this.visitedMinX) this.visitedMinX = x;
        if (x > this.visitedMaxX) this.visitedMaxX = x;
        if (y < this.visitedMinY) this.visitedMinY = y;
        if (y > this.visitedMaxY) this.visitedMaxY = y;

        // Move forward
        ant.dir = dir;
        ant.x = x + DX[dir];
        ant.y = y + DY[dir];
      }

      this.stepCount++;
    }
  }

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  render() {
    const { ctx, canvas, params, _offCtx, _offCanvas } = this;
    const cw = canvas.width;
    const ch = canvas.height;

    if (!this.imgData || !_offCtx) return;

    // 1. Compute view transform (smooth zoom-to-fit)
    this._computeView();

    const cs = params.cellSize;
    const scale = this.viewScale;
    const ox = this.viewOffsetX;
    const oy = this.viewOffsetY;
    const cellPx = cs * scale;

    // 2. Determine the visible region in grid coordinates
    //    Only push that sub-rect of ImageData to the offscreen canvas.
    const vx0 = Math.max(0, Math.floor(-ox / cellPx));
    const vy0 = Math.max(0, Math.floor(-oy / cellPx));
    const vx1 = Math.min(this.gridW - 1, Math.ceil((cw - ox) / cellPx));
    const vy1 = Math.min(this.gridH - 1, Math.ceil((ch - oy) / cellPx));

    // Expand to also include the full visited region (for zoom-to-fit)
    const rx0 = Math.max(0, Math.min(vx0, this.visitedMinX <= this.visitedMaxX ? this.visitedMinX : vx0));
    const ry0 = Math.max(0, Math.min(vy0, this.visitedMinY <= this.visitedMaxY ? this.visitedMinY : vy0));
    const rx1 = Math.min(this.gridW - 1, Math.max(vx1, this.visitedMaxX >= 0 ? this.visitedMaxX : vx1));
    const ry1 = Math.min(this.gridH - 1, Math.max(vy1, this.visitedMaxY >= 0 ? this.visitedMaxY : vy1));

    const rw = rx1 - rx0 + 1;
    const rh = ry1 - ry0 + 1;

    if (rw > 0 && rh > 0) {
      // putImageData with dirty rect: only transfers the needed sub-rectangle
      _offCtx.putImageData(this.imgData, 0, 0, rx0, ry0, rw, rh);
    }

    // 3. Clear main canvas
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, cw, ch);

    // 4. Draw the offscreen cell image scaled to the main canvas
    //    Each grid cell = cellSize * scale pixels on screen.
    //    Only blit the visible+visited sub-rect for performance.
    if (rw > 0 && rh > 0) {
      ctx.save();
      ctx.imageSmoothingEnabled = false; // crisp pixel art
      const dstX = ox + rx0 * cellPx;
      const dstY = oy + ry0 * cellPx;
      const dstW = rw * cellPx;
      const dstH = rh * cellPx;
      ctx.drawImage(_offCanvas, rx0, ry0, rw, rh, dstX, dstY, dstW, dstH);
      ctx.restore();
    }

    // 5. Draw ants on top
    if (params.showAnts) {
      this._drawAnts(ctx, ox, oy, cellPx);
    }
  }

  /**
   * Compute target viewScale and viewOffset based on zoomToFit,
   * then smoothly interpolate current values toward targets.
   */
  _computeView() {
    const { canvas, params, gridW, gridH } = this;
    const cw = canvas.width;
    const ch = canvas.height;
    const cs = params.cellSize;

    if (params.zoomToFit && this.visitedMinX <= this.visitedMaxX) {
      // Fit the visited bounding box (with padding) into the canvas
      const pad = 30;
      const bx0 = Math.max(0, this.visitedMinX - pad);
      const by0 = Math.max(0, this.visitedMinY - pad);
      const bx1 = Math.min(gridW - 1, this.visitedMaxX + pad);
      const by1 = Math.min(gridH - 1, this.visitedMaxY + pad);

      const regionW = bx1 - bx0 + 1;
      const regionH = by1 - by0 + 1;
      const bw = regionW * cs;
      const bh = regionH * cs;

      if (bw > 0 && bh > 0) {
        const scaleX = cw / bw;
        const scaleY = ch / bh;
        this._targetScale = Math.min(scaleX, scaleY, 1);

        // Center the bounding box region in the canvas
        const s = this._targetScale;
        const regionCenterX = (bx0 + regionW / 2) * cs;
        const regionCenterY = (by0 + regionH / 2) * cs;
        this._targetOX = cw / 2 - regionCenterX * s;
        this._targetOY = ch / 2 - regionCenterY * s;
      }
    } else {
      // 1:1, center the grid
      this._targetScale = 1;
      this._targetOX = (cw - gridW * cs) / 2;
      this._targetOY = (ch - gridH * cs) / 2;
    }

    // Smooth interpolation
    const blend = 0.1;
    this.viewScale += (this._targetScale - this.viewScale) * blend;
    this.viewOffsetX += (this._targetOX - this.viewOffsetX) * blend;
    this.viewOffsetY += (this._targetOY - this.viewOffsetY) * blend;
  }

  /** Draw ant indicators as directional arrows/triangles. */
  _drawAnts(ctx, ox, oy, cellPx) {
    const size = Math.max(cellPx * 0.8, 3);
    const half = size / 2;

    for (let a = 0; a < this.ants.length; a++) {
      const ant = this.ants[a];
      const { x, y, dir } = ant;

      if (x < 0 || x >= this.gridW || y < 0 || y >= this.gridH) continue;

      const cx = ox + (x + 0.5) * cellPx;
      const cy = oy + (y + 0.5) * cellPx;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((dir * Math.PI) / 2);

      // Triangle pointing up (before rotation)
      ctx.beginPath();
      ctx.moveTo(0, -half);
      ctx.lineTo(-half * 0.7, half * 0.6);
      ctx.lineTo(half * 0.7, half * 0.6);
      ctx.closePath();

      const color = ANT_COLORS[a % ANT_COLORS.length];
      ctx.fillStyle = color;
      ctx.fill();

      // Glow
      ctx.shadowColor = color;
      ctx.shadowBlur = Math.max(6, cellPx * 1.5);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.restore();
    }
  }

  // --------------------------------------------------------------------------
  // Interaction
  // --------------------------------------------------------------------------

  handleClick(canvasX, canvasY) {
    const cs = this.params.cellSize;
    const scale = this.viewScale;
    const cellPx = cs * scale;
    const gx = Math.floor((canvasX - this.viewOffsetX) / cellPx);
    const gy = Math.floor((canvasY - this.viewOffsetY) / cellPx);

    if (gx < 0 || gx >= this.gridW || gy < 0 || gy >= this.gridH) return;

    // Place a new ant (up to 8)
    if (this.ants.length < 8) {
      this.ants.push({ x: gx, y: gy, dir: 0 });
      this.params.antCount = this.ants.length;
    }
  }

  handleResize(width, height) {
    // Canvas dimensions are managed by app.js (DPR-aware).
    // Just store logical size for rendering calculations.
    // Zoom-to-fit will handle the new viewport.
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /** Parse rule string into turn-direction array and build color palettes. */
  _parseRule(ruleStr) {
    const upper = ruleStr.toUpperCase();
    this.numStates = upper.length;
    this.ruleChars = new Uint8Array(this.numStates);
    for (let i = 0; i < this.numStates; i++) {
      this.ruleChars[i] = upper[i] === 'L' ? 1 : 0;
    }
    this.palette = generatePalette(this.numStates);
    this.paletteCSS = this.palette.map(([r, g, b]) => `rgb(${r},${g},${b})`);
    this.paletteCSS[0] = '#0a0a0f';

    // Flat palette for pixel buffer
    this.paletteFlat = new Uint8Array(this.numStates * 3);
    for (let i = 0; i < this.numStates; i++) {
      this.paletteFlat[i * 3] = this.palette[i][0];
      this.paletteFlat[i * 3 + 1] = this.palette[i][1];
      this.paletteFlat[i * 3 + 2] = this.palette[i][2];
    }
    // Ensure state 0 = background color
    this.paletteFlat[0] = 10;
    this.paletteFlat[1] = 10;
    this.paletteFlat[2] = 15;

    this._palette32 = null; // force rebuild
  }

  /** Build Uint32 palette for direct pixel[idx] = value writes. */
  _buildPalette32() {
    this._palette32 = new Uint32Array(this.numStates);
    const pf = this.paletteFlat;
    for (let i = 0; i < this.numStates; i++) {
      const r = pf[i * 3];
      const g = pf[i * 3 + 1];
      const b = pf[i * 3 + 2];
      // ABGR byte order for little-endian (standard on all modern platforms)
      this._palette32[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
  }

  /** Allocate the grid. Fixed generous size, independent of canvas. */
  _allocateGrid() {
    // Grid size: 3000x3000 gives plenty of room for the highway (~10k steps)
    // and extended rulesets. ~9MB for Uint8Array, manageable.
    const dim = 3000;
    this.gridW = dim;
    this.gridH = dim;
    this.grid = new Uint8Array(dim * dim);
  }

  /** Initialize the ImageData pixel buffer (1 pixel per cell). */
  _initImageBuffer() {
    const w = this.gridW;
    const h = this.gridH;

    // Create ImageData and fill with background color
    this.imgData = new ImageData(w, h);
    const data = this.imgData.data;
    // Background: rgb(10, 10, 15), alpha 255
    for (let i = 0, len = w * h * 4; i < len; i += 4) {
      data[i] = 10;
      data[i + 1] = 10;
      data[i + 2] = 15;
      data[i + 3] = 255;
    }

    // Create a Uint32Array view for fast pixel writes
    this.pixels = new Uint32Array(this.imgData.data.buffer);

    // Dirty cell tracking buffer
    this._dirtyCells = new Int32Array(1024);
    this._dirtyCount = 0;
  }

  /** Create offscreen canvas matching grid dimensions. */
  _initOffscreenCanvas() {
    this._offCanvas = document.createElement('canvas');
    this._offCanvas.width = this.gridW;
    this._offCanvas.height = this.gridH;
    this._offCtx = this._offCanvas.getContext('2d');
  }

  /** Place N ants near the center of the grid. */
  _placeAnts(count) {
    this.ants = [];
    const cx = Math.floor(this.gridW / 2);
    const cy = Math.floor(this.gridH / 2);
    const spread = 20;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const r = i === 0 ? 0 : spread;
      this.ants.push({
        x: cx + Math.round(Math.cos(angle) * r),
        y: cy + Math.round(Math.sin(angle) * r),
        dir: i % 4,
      });
    }
  }

  /** Add a single ant near center for dynamic ant-count increase. */
  _addAntAtCenter(index) {
    const cx = Math.floor(this.gridW / 2);
    const cy = Math.floor(this.gridH / 2);
    const spread = 20;
    const angle = (index / 8) * Math.PI * 2;
    const r = index === 0 ? 0 : spread;
    this.ants.push({
      x: cx + Math.round(Math.cos(angle) * r),
      y: cy + Math.round(Math.sin(angle) * r),
      dir: index % 4,
    });
  }

  _resetVisitedBounds() {
    this.visitedMinX = Infinity;
    this.visitedMinY = Infinity;
    this.visitedMaxX = -Infinity;
    this.visitedMaxY = -Infinity;
  }
}
