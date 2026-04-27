// ============================================================================
// Conway's Game of Life — Emergence Interactive Artificial Life Laboratory
// ============================================================================
// Cellular automaton with color aging, ghost trails, multiple rulesets,
// pattern stamps, and drawing interaction.
// ============================================================================

const RULESETS = [
  { name: 'Classic',    birth: [3],          survive: [2, 3]             },
  { name: 'HighLife',   birth: [3, 6],       survive: [2, 3]             },
  { name: 'DayNight',   birth: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8]   },
];

// Pre-computed lookup tables for fast rule checking (one per ruleset).
// birthLUT[n] = true if a dead cell with n neighbors is born.
// surviveLUT[n] = true if a live cell with n neighbors survives.
function buildLUT(ruleset) {
  const b = new Uint8Array(9);
  const s = new Uint8Array(9);
  for (const v of ruleset.birth)   b[v] = 1;
  for (const v of ruleset.survive) s[v] = 1;
  return { b, s };
}

const RULE_LUTS = RULESETS.map(buildLUT);

// ---------------------------------------------------------------------------
// Pattern library — each pattern is stored as an array of [dx, dy] offsets.
// ---------------------------------------------------------------------------
const PATTERNS = {
  glider: {
    label: 'Glider',
    cells: [[1,0],[2,1],[0,2],[1,2],[2,2]],
  },
  lwss: {
    label: 'LWSS',
    cells: [[1,0],[4,0],[0,1],[0,2],[4,2],[0,3],[1,3],[2,3],[3,3]],
  },
  pulsar: {
    label: 'Pulsar',
    cells: (() => {
      // Pulsar is symmetric — define one quadrant + reflect.
      const q = [[2,1],[3,1],[4,1],[1,2],[1,3],[1,4],[2,6],[3,6],[4,6],[1,7],[1,8],[1,9]];
      const out = [];
      for (const [x, y] of q) {
        out.push([x, y], [-x + 12, y], [x, -y + 12], [-x + 12, -y + 12]);
      }
      // Deduplicate (center axis overlaps)
      const set = new Set(out.map(p => `${p[0]},${p[1]}`));
      return [...set].map(s => s.split(',').map(Number));
    })(),
  },
  rpentomino: {
    label: 'R-pentomino',
    cells: [[1,0],[2,0],[0,1],[1,1],[1,2]],
  },
  gospergun: {
    label: 'Gosper Glider Gun',
    cells: [
      [24,0],
      [22,1],[24,1],
      [12,2],[13,2],[20,2],[21,2],[34,2],[35,2],
      [11,3],[15,3],[20,3],[21,3],[34,3],[35,3],
      [0,4],[1,4],[10,4],[16,4],[20,4],[21,4],
      [0,5],[1,5],[10,5],[14,5],[16,5],[17,5],[22,5],[24,5],
      [10,6],[16,6],[24,6],
      [11,7],[15,7],
      [12,8],[13,8],
    ],
  },
};

// ---------------------------------------------------------------------------
// Aging palette — cells transition through these hues as they age.
// Each entry: [r, g, b] at a given age threshold.
// We interpolate linearly between entries.
// ---------------------------------------------------------------------------
const AGE_COLORS = [
  { age: 0,   r: 255, g: 255, b: 255 },  // white (newborn)
  { age: 4,   r: 130, g: 255, b: 255 },  // bright cyan
  { age: 12,  r: 50,  g: 180, b: 255 },  // sky blue
  { age: 30,  r: 80,  g: 100, b: 255 },  // blue
  { age: 60,  r: 140, g: 70,  b: 220 },  // purple
  { age: 120, r: 90,  g: 40,  b: 150 },  // deep purple
  { age: 250, r: 50,  g: 25,  b: 90  },  // near-dark
];

function ageToColor(age) {
  if (age <= 0) return AGE_COLORS[0];
  if (age >= AGE_COLORS[AGE_COLORS.length - 1].age) {
    const c = AGE_COLORS[AGE_COLORS.length - 1];
    return c;
  }
  for (let i = 1; i < AGE_COLORS.length; i++) {
    if (age <= AGE_COLORS[i].age) {
      const a = AGE_COLORS[i - 1];
      const b = AGE_COLORS[i];
      const t = (age - a.age) / (b.age - a.age);
      return {
        r: a.r + (b.r - a.r) * t | 0,
        g: a.g + (b.g - a.g) * t | 0,
        b: a.b + (b.b - a.b) * t | 0,
      };
    }
  }
  return AGE_COLORS[AGE_COLORS.length - 1];
}

// Ghost trail fade colors for cells that just died (frames 1..GHOST_FRAMES).
const GHOST_FRAMES = 4;

function ghostColor(frame, lastR, lastG, lastB) {
  // Fade from a dim version of the last living color toward transparent black.
  const t = frame / GHOST_FRAMES; // 0→1 as ghost fades out
  const alpha = 0.35 * (1 - t);
  return { r: lastR, g: lastG, b: lastB, a: alpha };
}

// ============================================================================
// Main class
// ============================================================================

export default class GameOfLife {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.running = false;

    // Parameters with defaults
    this.params = {
      cellSize: 6,
      speed: 15,
      showGrid: false,
      showAge: true,
      randomDensity: 0.3,
      ruleSet: 0,
    };

    // Grid state (allocated in init)
    this.cols = 0;
    this.rows = 0;
    this.grid = null;       // Uint8Array — 1 = alive, 0 = dead
    this.nextGrid = null;   // double buffer
    this.age = null;        // Uint16Array — age of each living cell
    this.ghost = null;      // Uint8Array — ghost countdown per cell
    this.ghostR = null;     // last living color channels (for smooth ghost)
    this.ghostG = null;
    this.ghostB = null;

    // Timing
    this._accumulator = 0;

    // Drawing interaction state
    this._drawing = false;
    this._drawValue = 1; // 1 = place cells, 0 = erase
    this._lastDrawCol = -1;
    this._lastDrawRow = -1;

    // Bound event handlers (for cleanup)
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onTouchStart = this._handleTouchStart.bind(this);
    this._onTouchMove = this._handleTouchMove.bind(this);
    this._onTouchEnd = this._handleTouchEnd.bind(this);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  init() {
    this._allocateGrid();
    this.randomize(this.params.randomDensity);
    this._accumulator = 0;
    this._attachListeners();
  }

  reset() {
    this._allocateGrid();
    this.randomize(this.params.randomDensity);
    this._accumulator = 0;
  }

  destroy() {
    this._detachListeners();
    this.grid = null;
    this.nextGrid = null;
    this.age = null;
    this.ghost = null;
    this.ghostR = null;
    this.ghostG = null;
    this.ghostB = null;
  }

  // --------------------------------------------------------------------------
  // Grid allocation
  // --------------------------------------------------------------------------

  _allocateGrid() {
    const cs = this.params.cellSize;
    this.cols = Math.floor(this.canvas.width / cs);
    this.rows = Math.floor(this.canvas.height / cs);
    const len = this.cols * this.rows;

    this.grid = new Uint8Array(len);
    this.nextGrid = new Uint8Array(len);
    this.age = new Uint16Array(len);
    this.ghost = new Uint8Array(len);
    this.ghostR = new Uint8Array(len);
    this.ghostG = new Uint8Array(len);
    this.ghostB = new Uint8Array(len);
  }

  // --------------------------------------------------------------------------
  // Simulation step
  // --------------------------------------------------------------------------

  update(dt) {
    const interval = 1000 / this.params.speed;
    this._accumulator += dt;

    // Process as many generations as the accumulator allows.
    while (this._accumulator >= interval) {
      this._accumulator -= interval;
      this._step();
    }
  }

  _step() {
    const { cols, rows, grid, nextGrid, age, ghost, ghostR, ghostG, ghostB } = this;
    const lut = RULE_LUTS[this.params.ruleSet] || RULE_LUTS[0];
    const bLUT = lut.b;
    const sLUT = lut.s;
    const showAge = this.params.showAge;

    for (let y = 0; y < rows; y++) {
      const ym1 = y === 0 ? rows - 1 : y - 1;
      const yp1 = y === rows - 1 ? 0 : y + 1;
      const rowOff = y * cols;
      const rowOffUp = ym1 * cols;
      const rowOffDn = yp1 * cols;

      for (let x = 0; x < cols; x++) {
        const xm1 = x === 0 ? cols - 1 : x - 1;
        const xp1 = x === cols - 1 ? 0 : x + 1;

        // Count neighbours (toroidal wrap)
        const neighbors =
          grid[rowOffUp + xm1] + grid[rowOffUp + x] + grid[rowOffUp + xp1] +
          grid[rowOff  + xm1]                        + grid[rowOff  + xp1] +
          grid[rowOffDn + xm1] + grid[rowOffDn + x] + grid[rowOffDn + xp1];

        const idx = rowOff + x;
        const alive = grid[idx];

        if (alive) {
          if (sLUT[neighbors]) {
            nextGrid[idx] = 1;
            if (showAge) {
              age[idx] = age[idx] < 65535 ? age[idx] + 1 : 65535;
            }
          } else {
            // Cell dies — start ghost
            nextGrid[idx] = 0;
            ghost[idx] = GHOST_FRAMES;
            // Store last color for ghost trail
            if (showAge) {
              const c = ageToColor(age[idx]);
              ghostR[idx] = c.r;
              ghostG[idx] = c.g;
              ghostB[idx] = c.b;
            } else {
              ghostR[idx] = 130;
              ghostG[idx] = 255;
              ghostB[idx] = 255;
            }
            age[idx] = 0;
          }
        } else {
          if (bLUT[neighbors]) {
            nextGrid[idx] = 1;
            age[idx] = 0;
            ghost[idx] = 0;
          } else {
            nextGrid[idx] = 0;
            // Tick ghost countdown
            if (ghost[idx] > 0) ghost[idx]--;
          }
        }
      }
    }

    // Swap buffers
    this.grid = nextGrid;
    this.nextGrid = grid;
    // Clear the old "next" buffer for the next step.
    // (We overwrite every cell each step, so we don't strictly need this,
    //  but it's cheap insurance.)
  }

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  render() {
    const { ctx, canvas, params, cols, rows, grid, age, ghost, ghostR, ghostG, ghostB } = this;
    const cs = params.cellSize;
    const showAge = params.showAge;
    const showGrid = params.showGrid;

    // Clear to near-black
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Optional grid lines
    if (showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let x = 0; x <= cols; x++) {
        const px = x * cs;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, rows * cs);
      }
      for (let y = 0; y <= rows; y++) {
        const py = y * cs;
        ctx.moveTo(0, py);
        ctx.lineTo(cols * cs, py);
      }
      ctx.stroke();
    }

    // Gap between cells (pixel gap scales with cell size)
    const gap = cs >= 4 ? 1 : 0;
    const inner = cs - gap;

    // Render ghosts first (underneath live cells)
    for (let y = 0; y < rows; y++) {
      const rowOff = y * cols;
      for (let x = 0; x < cols; x++) {
        const idx = rowOff + x;
        if (ghost[idx] > 0 && !grid[idx]) {
          const gc = ghostColor(GHOST_FRAMES - ghost[idx], ghostR[idx], ghostG[idx], ghostB[idx]);
          ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},${gc.a.toFixed(3)})`;
          ctx.fillRect(x * cs, y * cs, inner, inner);
        }
      }
    }

    // Render living cells — batch by color where possible.
    // For maximum performance we group cells into color buckets.
    if (showAge) {
      // Use a map of color strings to avoid re-setting fillStyle per cell.
      // With many unique ages this is less effective, so we use a cache.
      const colorCache = new Map();

      for (let y = 0; y < rows; y++) {
        const rowOff = y * cols;
        for (let x = 0; x < cols; x++) {
          const idx = rowOff + x;
          if (!grid[idx]) continue;

          const a = age[idx];
          let cStr = colorCache.get(a);
          if (cStr === undefined) {
            const c = ageToColor(a);
            cStr = `rgb(${c.r},${c.g},${c.b})`;
            colorCache.set(a, cStr);
          }
          ctx.fillStyle = cStr;
          ctx.fillRect(x * cs, y * cs, inner, inner);
        }
      }
    } else {
      // Uniform color — fast path
      ctx.fillStyle = '#82ffff';
      for (let y = 0; y < rows; y++) {
        const rowOff = y * cols;
        for (let x = 0; x < cols; x++) {
          if (grid[rowOff + x]) {
            ctx.fillRect(x * cs, y * cs, inner, inner);
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Interaction
  // --------------------------------------------------------------------------

  handleClick(x, y) {
    // Single click toggles a cell
    const cs = this.params.cellSize;
    const col = Math.floor(x / cs);
    const row = Math.floor(y / cs);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return;
    const idx = row * this.cols + col;
    this.grid[idx] = this.grid[idx] ? 0 : 1;
    if (this.grid[idx]) {
      this.age[idx] = 0;
    }
  }

  handleResize(width, height) {
    // Preserve as much of the existing grid as possible.
    const oldCols = this.cols;
    const oldRows = this.rows;
    const oldGrid = this.grid;
    const oldAge = this.age;

    const cs = this.params.cellSize;
    this.cols = Math.floor(width / cs);
    this.rows = Math.floor(height / cs);
    const len = this.cols * this.rows;

    this.grid = new Uint8Array(len);
    this.nextGrid = new Uint8Array(len);
    this.age = new Uint16Array(len);
    this.ghost = new Uint8Array(len);
    this.ghostR = new Uint8Array(len);
    this.ghostG = new Uint8Array(len);
    this.ghostB = new Uint8Array(len);

    if (oldGrid) {
      const copyC = Math.min(oldCols, this.cols);
      const copyR = Math.min(oldRows, this.rows);
      for (let y = 0; y < copyR; y++) {
        for (let x = 0; x < copyC; x++) {
          const ni = y * this.cols + x;
          const oi = y * oldCols + x;
          this.grid[ni] = oldGrid[oi];
          if (oldAge) this.age[ni] = oldAge[oi];
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Mouse / touch drawing
  // --------------------------------------------------------------------------

  _attachListeners() {
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    window.addEventListener('touchend', this._onTouchEnd);
  }

  _detachListeners() {
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('touchstart', this._onTouchStart);
    this.canvas.removeEventListener('touchmove', this._onTouchMove);
    window.removeEventListener('touchend', this._onTouchEnd);
  }

  _canvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
      y: (e.clientY - rect.top) * (this.canvas.height / rect.height),
    };
  }

  _handleMouseDown(e) {
    const { x, y } = this._canvasCoords(e);
    const cs = this.params.cellSize;
    const col = Math.floor(x / cs);
    const row = Math.floor(y / cs);

    // Shift+click → stamp a pattern
    if (e.shiftKey) {
      this.stampPattern('glider', col, row);
      return;
    }

    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return;

    this._drawing = true;
    const idx = row * this.cols + col;
    // Toggle: if the clicked cell is alive, we erase; otherwise we draw.
    this._drawValue = this.grid[idx] ? 0 : 1;
    this.grid[idx] = this._drawValue;
    if (this._drawValue) this.age[idx] = 0;
    this._lastDrawCol = col;
    this._lastDrawRow = row;
  }

  _handleMouseMove(e) {
    if (!this._drawing) return;
    const { x, y } = this._canvasCoords(e);
    const cs = this.params.cellSize;
    const col = Math.floor(x / cs);
    const row = Math.floor(y / cs);
    if (col === this._lastDrawCol && row === this._lastDrawRow) return;
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return;

    // Bresenham between last and current to avoid gaps at fast drags
    this._drawLine(this._lastDrawCol, this._lastDrawRow, col, row);
    this._lastDrawCol = col;
    this._lastDrawRow = row;
  }

  _handleMouseUp() {
    this._drawing = false;
  }

  _handleTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    this._handleMouseDown({ clientX: touch.clientX, clientY: touch.clientY, shiftKey: false });
  }

  _handleTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    this._handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
  }

  _handleTouchEnd() {
    this._drawing = false;
  }

  _drawLine(x0, y0, x1, y1) {
    // Bresenham's line algorithm
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
      if (x0 >= 0 && x0 < this.cols && y0 >= 0 && y0 < this.rows) {
        const idx = y0 * this.cols + x0;
        this.grid[idx] = this._drawValue;
        if (this._drawValue) this.age[idx] = 0;
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx)  { err += dx; y0 += sy; }
    }
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
        min: 2,
        max: 20,
        step: 1,
        value: this.params.cellSize,
      },
      {
        name: 'speed',
        label: 'Speed (gen/s)',
        type: 'range',
        min: 1,
        max: 60,
        step: 1,
        value: this.params.speed,
      },
      {
        name: 'showGrid',
        label: 'Show Grid',
        type: 'checkbox',
        value: this.params.showGrid,
      },
      {
        name: 'showAge',
        label: 'Color Aging',
        type: 'checkbox',
        value: this.params.showAge,
      },
      {
        name: 'randomDensity',
        label: 'Random Density',
        type: 'range',
        min: 0.1,
        max: 0.9,
        step: 0.05,
        value: this.params.randomDensity,
      },
      {
        name: 'ruleSet',
        label: 'Rules',
        type: 'range',
        min: 0,
        max: RULESETS.length - 1,
        step: 1,
        value: this.params.ruleSet,
      },
    ];
  }

  setParam(name, value) {
    if (!(name in this.params)) return;

    const old = this.params[name];

    switch (name) {
      case 'cellSize':
        this.params.cellSize = Math.max(2, Math.min(20, Math.round(value)));
        if (this.params.cellSize !== old) {
          this.handleResize(this.canvas.width, this.canvas.height);
        }
        break;

      case 'speed':
        this.params.speed = Math.max(1, Math.min(60, Math.round(value)));
        break;

      case 'showGrid':
        this.params.showGrid = !!value;
        break;

      case 'showAge':
        this.params.showAge = !!value;
        break;

      case 'randomDensity':
        this.params.randomDensity = Math.max(0.1, Math.min(0.9, +value));
        break;

      case 'ruleSet':
        this.params.ruleSet = Math.max(0, Math.min(RULESETS.length - 1, Math.round(value)));
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Public utilities
  // --------------------------------------------------------------------------

  /**
   * Fill the grid randomly.
   * @param {number} [density] - Fraction of cells to fill (0..1).
   */
  randomize(density) {
    const d = density !== undefined ? density : this.params.randomDensity;
    const len = this.cols * this.rows;
    for (let i = 0; i < len; i++) {
      this.grid[i] = Math.random() < d ? 1 : 0;
      this.age[i] = 0;
      this.ghost[i] = 0;
    }
  }

  /**
   * Place a named pattern at the given grid coordinates.
   * @param {string} name   - Pattern key (e.g. 'glider', 'gospergun').
   * @param {number} col    - Grid column for top-left of pattern.
   * @param {number} row    - Grid row for top-left of pattern.
   */
  stampPattern(name, col, row) {
    const pattern = PATTERNS[name];
    if (!pattern) return;

    for (const [dx, dy] of pattern.cells) {
      let c = col + dx;
      let r = row + dy;
      // Wrap toroidally
      c = ((c % this.cols) + this.cols) % this.cols;
      r = ((r % this.rows) + this.rows) % this.rows;
      const idx = r * this.cols + c;
      this.grid[idx] = 1;
      this.age[idx] = 0;
      this.ghost[idx] = 0;
    }
  }

  /**
   * Return an array of available pattern names (keys).
   * @returns {string[]}
   */
  getPatternNames() {
    return Object.keys(PATTERNS);
  }

  /**
   * Return pattern metadata for UI display.
   * @returns {{ key: string, label: string }[]}
   */
  getPatterns() {
    return Object.entries(PATTERNS).map(([key, val]) => ({ key, label: val.label }));
  }
}
