/**
 * Particle Life - Interactive Artificial Life Simulation
 *
 * Colored particles interact through attraction/repulsion forces
 * defined by a random interaction matrix. Emergent behaviors include
 * clustering, chasing, orbiting, and self-organizing structures.
 */

const NEON_PALETTE = [
  '#ff006e', // hot pink
  '#00f5d4', // cyan-mint
  '#fee440', // electric yellow
  '#8338ec', // vivid purple
  '#3a86ff', // bright blue
  '#fb5607', // blaze orange
  '#7fff00', // chartreuse
  '#ff595e', // coral red
];

export default class ParticleLife {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.running = false;

    // Default parameter values
    this.params = {
      particleCount: 400,
      friction: 0.5,
      maxRadius: 150,
      forceStrength: 1.0,
      speciesCount: 6,
      showTrails: false,
    };

    this.particles = [];
    this.attractionMatrix = [];
    this.colors = [];
    this.grid = null;
    this.gridCols = 0;
    this.gridRows = 0;
    this.cellSize = 0;

    // Interaction state
    this._dragPrevious = null;
    this._boundMouseDown = null;
    this._boundMouseMove = null;
    this._boundMouseUp = null;
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  init() {
    this._buildPalette();
    this._generateMatrix();
    this._spawnParticles(this.params.particleCount);
    this._buildGrid();
    this._attachInputListeners();
  }

  reset() {
    this._detachInputListeners();
    this.particles = [];
    this.init();
  }

  destroy() {
    this._detachInputListeners();
    this.particles = [];
    this.attractionMatrix = [];
    this.grid = null;
  }

  // ---------------------------------------------------------------
  // Parameters
  // ---------------------------------------------------------------

  getParams() {
    return [
      {
        name: 'particleCount',
        label: 'Particles',
        type: 'range',
        min: 100,
        max: 1000,
        step: 10,
        value: this.params.particleCount,
      },
      {
        name: 'friction',
        label: 'Friction',
        type: 'range',
        min: 0.01,
        max: 0.99,
        step: 0.01,
        value: this.params.friction,
      },
      {
        name: 'maxRadius',
        label: 'Max Radius',
        type: 'range',
        min: 50,
        max: 300,
        step: 5,
        value: this.params.maxRadius,
      },
      {
        name: 'forceStrength',
        label: 'Force Strength',
        type: 'range',
        min: 0.1,
        max: 5,
        step: 0.1,
        value: this.params.forceStrength,
      },
      {
        name: 'speciesCount',
        label: 'Species',
        type: 'range',
        min: 2,
        max: 8,
        step: 1,
        value: this.params.speciesCount,
      },
      {
        name: 'showTrails',
        label: 'Show Trails',
        type: 'checkbox',
        value: this.params.showTrails,
      },
    ];
  }

  setParam(name, value) {
    if (!(name in this.params)) return;

    const old = this.params[name];
    this.params[name] = value;

    switch (name) {
      case 'particleCount': {
        const diff = value - this.particles.length;
        if (diff > 0) {
          this._spawnParticles(diff);
        } else if (diff < 0) {
          this.particles.length = value;
        }
        break;
      }
      case 'speciesCount':
        if (value !== old) {
          this._buildPalette();
          this._generateMatrix();
          // Re-assign species so they stay within bounds
          for (const p of this.particles) {
            p.species = p.species % value;
          }
        }
        break;
      case 'maxRadius':
        this._buildGrid();
        break;
    }
  }

  // ---------------------------------------------------------------
  // Simulation step
  // ---------------------------------------------------------------

  update(dt) {
    const dtSec = Math.min(dt / 1000, 0.05); // cap to avoid spiral of death
    const w = this.canvas.width;
    const h = this.canvas.height;
    const halfW = w * 0.5;
    const halfH = h * 0.5;
    const maxR = this.params.maxRadius;
    const maxR2 = maxR * maxR;
    const strength = this.params.forceStrength;
    const friction = this.params.friction;
    const speciesCount = this.params.speciesCount;
    const n = this.particles.length;

    // Populate spatial grid
    this._populateGrid();

    const grid = this.grid;
    const cols = this.gridCols;
    const rows = this.gridRows;
    const cellSize = this.cellSize;
    const matrix = this.attractionMatrix;

    // For each particle, accumulate forces from neighbours
    for (let i = 0; i < n; i++) {
      const pi = this.particles[i];
      let fx = 0;
      let fy = 0;

      // Determine grid cell of this particle
      const ci = (pi.x / cellSize) | 0;
      const ri = (pi.y / cellSize) | 0;

      // Search neighbouring cells (including self)
      const searchRadius = 1; // one ring of neighbours
      for (let dr = -searchRadius; dr <= searchRadius; dr++) {
        for (let dc = -searchRadius; dc <= searchRadius; dc++) {
          const col = ((ci + dc) % cols + cols) % cols;
          const row = ((ri + dr) % rows + rows) % rows;
          const cell = grid[row * cols + col];
          if (!cell) continue;
          const cellLen = cell.length;

          for (let k = 0; k < cellLen; k++) {
            const j = cell[k];
            if (j === i) continue;

            const pj = this.particles[j];

            // Toroidal distance
            let dx = pj.x - pi.x;
            let dy = pj.y - pi.y;
            if (dx > halfW) dx -= w;
            else if (dx < -halfW) dx += w;
            if (dy > halfH) dy -= h;
            else if (dy < -halfH) dy += h;

            const dist2 = dx * dx + dy * dy;
            if (dist2 >= maxR2 || dist2 < 1e-4) continue;

            const dist = Math.sqrt(dist2);
            const normDx = dx / dist;
            const normDy = dy / dist;

            // Attraction value from matrix
            const attraction = matrix[pi.species * speciesCount + pj.species];

            // Force profile: repel at very close range, attract/repel further
            let forceMag;
            const minDist = 20; // repulsion threshold

            if (dist < minDist) {
              // Universal short-range repulsion (prevents overlap)
              forceMag = (dist / minDist - 1) * strength;
            } else {
              // Attraction/repulsion zone – linear ramp up then down
              const t = (dist - minDist) / (maxR - minDist);
              // Smooth bell: peaks at t=0.3, falls to 0 at t=1
              const bell = t < 0.3
                ? t / 0.3
                : (1 - t) / 0.7;
              forceMag = attraction * bell * strength;
            }

            fx += normDx * forceMag;
            fy += normDy * forceMag;
          }
        }
      }

      // Apply force, friction, integrate
      pi.vx = (pi.vx + fx * dtSec * 60) * (1 - friction);
      pi.vy = (pi.vy + fy * dtSec * 60) * (1 - friction);

      // Speed cap to prevent explosions
      const speed2 = pi.vx * pi.vx + pi.vy * pi.vy;
      const maxSpeed = 8;
      if (speed2 > maxSpeed * maxSpeed) {
        const scale = maxSpeed / Math.sqrt(speed2);
        pi.vx *= scale;
        pi.vy *= scale;
      }
    }

    // Position integration (separate pass for consistency)
    for (let i = 0; i < n; i++) {
      const pi = this.particles[i];
      pi.x += pi.vx;
      pi.y += pi.vy;

      // Wrap toroidally
      if (pi.x < 0) pi.x += w;
      else if (pi.x >= w) pi.x -= w;
      if (pi.y < 0) pi.y += h;
      else if (pi.y >= h) pi.y -= h;
    }
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    if (this.params.showTrails) {
      // Fade previous frame for trails
      ctx.fillStyle = 'rgba(10, 10, 15, 0.15)';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, w, h);
    }

    const colors = this.colors;
    const n = this.particles.length;

    // Glow layer (drawn first, behind particles) - batched by species
    ctx.globalAlpha = 0.12;
    for (let s = 0; s < this.params.speciesCount; s++) {
      ctx.fillStyle = colors[s];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const p = this.particles[i];
        if (p.species !== s) continue;
        ctx.moveTo(p.x + 6, p.y);
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // Solid particles on top
    ctx.globalAlpha = 1.0;
    // Batch by species to minimize fillStyle changes
    for (let s = 0; s < this.params.speciesCount; s++) {
      ctx.fillStyle = colors[s];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const p = this.particles[i];
        if (p.species !== s) continue;
        ctx.moveTo(p.x + 2.5, p.y);
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------

  handleClick(x, y) {
    // Add a burst of particles at click position
    this._addBurst(x, y, 8);
  }

  handleResize(width, height) {
    // Keep particles within new bounds
    for (const p of this.particles) {
      if (p.x >= width) p.x = p.x % width;
      if (p.y >= height) p.y = p.y % height;
    }
    this._buildGrid();
  }

  // ---------------------------------------------------------------
  // Private: particle spawning
  // ---------------------------------------------------------------

  _spawnParticles(count) {
    const w = this.canvas.width || 800;
    const h = this.canvas.height || 600;
    const species = this.params.speciesCount;

    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: 0,
        vy: 0,
        species: (Math.random() * species) | 0,
      });
    }
  }

  _addBurst(x, y, count) {
    const species = this.params.speciesCount;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * 30;
      this.particles.push({
        x: x + Math.cos(angle) * r,
        y: y + Math.sin(angle) * r,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        species: (Math.random() * species) | 0,
      });
    }
    // Update param to reflect actual count
    this.params.particleCount = this.particles.length;
  }

  // ---------------------------------------------------------------
  // Private: interaction matrix
  // ---------------------------------------------------------------

  _buildPalette() {
    const count = this.params.speciesCount;
    this.colors = NEON_PALETTE.slice(0, count);
  }

  _generateMatrix() {
    const n = this.params.speciesCount;
    // Flat array: matrix[i * n + j] = attraction of species i toward species j
    // Range: -1 (full repulsion) to +1 (full attraction)
    this.attractionMatrix = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      this.attractionMatrix[i] = Math.random() * 2 - 1;
    }
  }

  // ---------------------------------------------------------------
  // Private: spatial partitioning grid
  // ---------------------------------------------------------------

  _buildGrid() {
    const w = this.canvas.width || 800;
    const h = this.canvas.height || 600;
    this.cellSize = Math.max(this.params.maxRadius, 50);
    this.gridCols = Math.max(1, Math.ceil(w / this.cellSize));
    this.gridRows = Math.max(1, Math.ceil(h / this.cellSize));
    this.grid = new Array(this.gridCols * this.gridRows);
  }

  _populateGrid() {
    const len = this.gridCols * this.gridRows;
    const grid = this.grid;

    // Clear grid
    for (let i = 0; i < len; i++) {
      if (grid[i]) {
        grid[i].length = 0;
      } else {
        grid[i] = [];
      }
    }

    const cellSize = this.cellSize;
    const cols = this.gridCols;
    const n = this.particles.length;

    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      const col = (p.x / cellSize) | 0;
      const row = (p.y / cellSize) | 0;
      const idx = row * cols + col;
      if (idx >= 0 && idx < len) {
        grid[idx].push(i);
      }
    }
  }

  // ---------------------------------------------------------------
  // Private: input listeners (drag to create bursts)
  // ---------------------------------------------------------------

  _attachInputListeners() {
    this._detachInputListeners();

    let dragging = false;
    let lastBurstTime = 0;

    this._boundMouseDown = (e) => {
      dragging = true;
      this._dragPrevious = { x: e.offsetX, y: e.offsetY };
    };

    this._boundMouseMove = (e) => {
      if (!dragging) return;
      const now = performance.now();
      if (now - lastBurstTime > 50) { // throttle burst to every 50ms
        lastBurstTime = now;
        this._addBurst(e.offsetX, e.offsetY, 3);
      }
    };

    this._boundMouseUp = () => {
      dragging = false;
      this._dragPrevious = null;
    };

    this.canvas.addEventListener('mousedown', this._boundMouseDown);
    this.canvas.addEventListener('mousemove', this._boundMouseMove);
    this.canvas.addEventListener('mouseup', this._boundMouseUp);
  }

  _detachInputListeners() {
    if (this._boundMouseDown) {
      this.canvas.removeEventListener('mousedown', this._boundMouseDown);
      this.canvas.removeEventListener('mousemove', this._boundMouseMove);
      this.canvas.removeEventListener('mouseup', this._boundMouseUp);
      this._boundMouseDown = null;
      this._boundMouseMove = null;
      this._boundMouseUp = null;
    }
  }
}
