// ─────────────────────────────────────────────────────────────
//  Boids  –  Flocking Simulation Module for Emergence
//  Craig Reynolds' three-rule model + predator/attractor interactions
// ─────────────────────────────────────────────────────────────

/* ── Spatial Hash Grid ──────────────────────────────────────── */

class SpatialHash {
  constructor(cellSize, width, height) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.cells = new Map();
  }

  resize(width, height) {
    this.cols = Math.ceil(width / this.cellSize);
    this.rows = Math.ceil(height / this.cellSize);
  }

  clear() {
    this.cells.clear();
  }

  _key(cx, cy) {
    // Wrap cell coords for toroidal topology
    cx = ((cx % this.cols) + this.cols) % this.cols;
    cy = ((cy % this.rows) + this.rows) % this.rows;
    return cy * this.cols + cx;
  }

  insert(boid) {
    const cx = Math.floor(boid.x / this.cellSize);
    const cy = Math.floor(boid.y / this.cellSize);
    const key = this._key(cx, cy);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(boid);
  }

  query(x, y, radius) {
    const results = [];
    const r = Math.ceil(radius / this.cellSize);
    const cx0 = Math.floor(x / this.cellSize);
    const cy0 = Math.floor(y / this.cellSize);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const key = this._key(cx0 + dx, cy0 + dy);
        const bucket = this.cells.get(key);
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) {
            results.push(bucket[i]);
          }
        }
      }
    }
    return results;
  }
}

/* ── Aurora / Oceanic palette helpers ───────────────────────── */

function hslToRgbString(h, s, l, a = 1) {
  // h in [0,360], s,l in [0,1]
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  r = Math.round((r + m) * 255);
  g = Math.round((g + m) * 255);
  b = Math.round((b + m) * 255);
  if (a < 1) return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  return `rgb(${r},${g},${b})`;
}

// Map a speed ratio [0,1] to an aurora/oceanic hue
function velocityColor(speedRatio) {
  // 0 = deep teal (180), 1 = vivid pink (320)
  // Mid-range passes through cyan (190), blue-purple (260)
  const hue = 180 + speedRatio * 140; // 180 → 320
  const sat = 0.75 + speedRatio * 0.2;
  const lit = 0.45 + speedRatio * 0.2;
  return hslToRgbString(hue, sat, lit);
}

function velocityColorAlpha(speedRatio, alpha) {
  const hue = 180 + speedRatio * 140;
  const sat = 0.75 + speedRatio * 0.2;
  const lit = 0.45 + speedRatio * 0.2;
  return hslToRgbString(hue, sat, lit, alpha);
}

/* ── Main Simulation ────────────────────────────────────────── */

export default class Boids {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.params = {};
    this.running = false;

    this.boids = [];
    this.predators = [];   // {x, y, born: timestamp, duration: 3000}
    this.attractors = [];  // {x, y, born: timestamp, duration: 3000}

    this.trailBuffer = null; // off-screen canvas for trails
    this.trailCtx = null;
    this.grid = null;
  }

  /* ── Lifecycle ────────────────────────────────────────────── */

  init() {
    this.params = {
      boidCount: 300,
      separation: 1.5,
      alignment: 1.0,
      cohesion: 1.0,
      maxSpeed: 4,
      visualRadius: 75,
      showTrails: false,
    };

    this._setupTrailBuffer();
    this._spawnBoids(this.params.boidCount);
    this.predators = [];
    this.attractors = [];
    this.grid = new SpatialHash(
      this.params.visualRadius,
      this.canvas.width,
      this.canvas.height
    );
  }

  reset() {
    this.init();
  }

  destroy() {
    this.boids = [];
    this.predators = [];
    this.attractors = [];
    this.trailBuffer = null;
    this.trailCtx = null;
    this.grid = null;
  }

  /* ── Spawning ─────────────────────────────────────────────── */

  _spawnBoids(count) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.boids = [];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 2;
      this.boids.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        // trail history (circular buffer of recent positions)
        trail: [],
        trailIdx: 0,
      });
    }
  }

  _setupTrailBuffer() {
    if (typeof OffscreenCanvas !== 'undefined') {
      this.trailBuffer = new OffscreenCanvas(this.canvas.width, this.canvas.height);
    } else {
      this.trailBuffer = document.createElement('canvas');
      this.trailBuffer.width = this.canvas.width;
      this.trailBuffer.height = this.canvas.height;
    }
    this.trailCtx = this.trailBuffer.getContext('2d');
  }

  /* ── Parameters ───────────────────────────────────────────── */

  getParams() {
    return [
      {
        name: 'boidCount', label: 'Boid Count', type: 'range',
        min: 50, max: 800, step: 10, value: this.params.boidCount,
      },
      {
        name: 'separation', label: 'Separation', type: 'range',
        min: 0, max: 5, step: 0.1, value: this.params.separation,
      },
      {
        name: 'alignment', label: 'Alignment', type: 'range',
        min: 0, max: 5, step: 0.1, value: this.params.alignment,
      },
      {
        name: 'cohesion', label: 'Cohesion', type: 'range',
        min: 0, max: 5, step: 0.1, value: this.params.cohesion,
      },
      {
        name: 'maxSpeed', label: 'Max Speed', type: 'range',
        min: 1, max: 10, step: 0.5, value: this.params.maxSpeed,
      },
      {
        name: 'visualRadius', label: 'Visual Radius', type: 'range',
        min: 30, max: 200, step: 5, value: this.params.visualRadius,
      },
      {
        name: 'showTrails', label: 'Show Trails', type: 'checkbox',
        value: this.params.showTrails,
      },
    ];
  }

  setParam(name, value) {
    if (name === 'boidCount') {
      const target = Math.round(value);
      this.params.boidCount = target;
      this._reconcileBoidCount(target);
    } else if (name === 'showTrails') {
      this.params[name] = !!value;
      // Clear trail buffer when toggling on
      if (this.params.showTrails && this.trailCtx) {
        this.trailCtx.clearRect(0, 0, this.trailBuffer.width, this.trailBuffer.height);
        for (const b of this.boids) { b.trail = []; b.trailIdx = 0; }
      }
    } else if (name === 'visualRadius') {
      this.params[name] = value;
      // Rebuild spatial hash with new cell size
      if (this.grid) {
        this.grid.cellSize = value;
        this.grid.resize(this.canvas.width, this.canvas.height);
      }
    } else {
      this.params[name] = value;
    }
  }

  _reconcileBoidCount(target) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    while (this.boids.length < target) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 2;
      this.boids.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        trail: [],
        trailIdx: 0,
      });
    }
    while (this.boids.length > target) {
      this.boids.pop();
    }
  }

  /* ── Interaction ──────────────────────────────────────────── */

  handleClick(x, y, event) {
    // Shift-click or right-click → attractor; normal click → predator
    const isAttractor = event && (event.shiftKey || event.button === 2);
    if (isAttractor) {
      this.attractors.push({ x, y, born: performance.now(), duration: 3000 });
    } else {
      this.predators.push({ x, y, born: performance.now(), duration: 3000 });
    }
  }

  handleResize(width, height) {
    // Remap boids proportionally
    const sx = width / (this.canvas.width || width);
    const sy = height / (this.canvas.height || height);
    for (const b of this.boids) {
      b.x *= sx;
      b.y *= sy;
      b.trail = [];
      b.trailIdx = 0;
    }
    if (this.grid) {
      this.grid.resize(width, height);
    }
    this._setupTrailBuffer();
  }

  /* ── Update (physics) ─────────────────────────────────────── */

  update(dt) {
    const {
      separation: sepW,
      alignment: aliW,
      cohesion: cohW,
      maxSpeed,
      visualRadius: radius,
    } = this.params;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const minSpeed = 1;
    const now = performance.now();

    // Prune expired predators / attractors
    this.predators = this.predators.filter(p => now - p.born < p.duration);
    this.attractors = this.attractors.filter(a => now - a.born < a.duration);

    // Rebuild spatial hash
    const grid = this.grid;
    grid.cellSize = radius;
    grid.resize(w, h);
    grid.clear();
    for (const b of this.boids) {
      grid.insert(b);
    }

    const radiusSq = radius * radius;
    const sepRadius = radius * 0.35;
    const sepRadiusSq = sepRadius * sepRadius;

    // Scale factor: normalise dt to a 16.67ms frame
    const dtScale = Math.min(dt / 16.667, 3);

    for (let i = 0; i < this.boids.length; i++) {
      const boid = this.boids[i];

      // Accumulators
      let sepX = 0, sepY = 0;
      let aliVx = 0, aliVy = 0;
      let cohX = 0, cohY = 0;
      let neighbors = 0;
      let sepCount = 0;

      const candidates = grid.query(boid.x, boid.y, radius);

      for (let j = 0; j < candidates.length; j++) {
        const other = candidates[j];
        if (other === boid) continue;

        // Toroidal distance
        let dx = other.x - boid.x;
        let dy = other.y - boid.y;
        if (dx > w * 0.5) dx -= w;
        else if (dx < -w * 0.5) dx += w;
        if (dy > h * 0.5) dy -= h;
        else if (dy < -h * 0.5) dy += h;

        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq || distSq === 0) continue;

        neighbors++;

        // Alignment
        aliVx += other.vx;
        aliVy += other.vy;

        // Cohesion
        cohX += dx;
        cohY += dy;

        // Separation (only very close neighbors)
        if (distSq < sepRadiusSq) {
          const dist = Math.sqrt(distSq);
          const strength = 1 - dist / sepRadius; // stronger when closer
          sepX -= (dx / dist) * strength;
          sepY -= (dy / dist) * strength;
          sepCount++;
        }
      }

      // Steering forces
      let ax = 0, ay = 0;

      if (neighbors > 0) {
        // Separation
        if (sepCount > 0) {
          ax += sepX * sepW * 0.8;
          ay += sepY * sepW * 0.8;
        }

        // Alignment: steer toward average velocity
        aliVx /= neighbors;
        aliVy /= neighbors;
        ax += (aliVx - boid.vx) * aliW * 0.1;
        ay += (aliVy - boid.vy) * aliW * 0.1;

        // Cohesion: steer toward center of neighbours
        cohX /= neighbors;
        cohY /= neighbors;
        ax += cohX * cohW * 0.005;
        ay += cohY * cohW * 0.005;
      }

      // Predator avoidance
      for (const pred of this.predators) {
        let dx = boid.x - pred.x;
        let dy = boid.y - pred.y;
        if (dx > w * 0.5) dx -= w;
        else if (dx < -w * 0.5) dx += w;
        if (dy > h * 0.5) dy -= h;
        else if (dy < -h * 0.5) dy += h;
        const distSq = dx * dx + dy * dy;
        const fleeRadius = 150;
        if (distSq < fleeRadius * fleeRadius && distSq > 0) {
          const dist = Math.sqrt(distSq);
          const fade = 1 - (now - pred.born) / pred.duration; // fades over time
          const strength = (1 - dist / fleeRadius) * fade * 3;
          ax += (dx / dist) * strength;
          ay += (dy / dist) * strength;
        }
      }

      // Attractor pull
      for (const att of this.attractors) {
        let dx = att.x - boid.x;
        let dy = att.y - boid.y;
        if (dx > w * 0.5) dx -= w;
        else if (dx < -w * 0.5) dx += w;
        if (dy > h * 0.5) dy -= h;
        else if (dy < -h * 0.5) dy += h;
        const distSq = dx * dx + dy * dy;
        const attractRadius = 200;
        if (distSq < attractRadius * attractRadius && distSq > 0) {
          const dist = Math.sqrt(distSq);
          const fade = 1 - (now - att.born) / att.duration;
          const strength = fade * 0.4;
          ax += (dx / dist) * strength;
          ay += (dy / dist) * strength;
        }
      }

      // Apply acceleration
      boid.vx += ax * dtScale;
      boid.vy += ay * dtScale;

      // Clamp speed
      const speed = Math.sqrt(boid.vx * boid.vx + boid.vy * boid.vy);
      if (speed > maxSpeed) {
        boid.vx = (boid.vx / speed) * maxSpeed;
        boid.vy = (boid.vy / speed) * maxSpeed;
      } else if (speed < minSpeed && speed > 0) {
        boid.vx = (boid.vx / speed) * minSpeed;
        boid.vy = (boid.vy / speed) * minSpeed;
      }

      // Move
      boid.x += boid.vx * dtScale;
      boid.y += boid.vy * dtScale;

      // Wrap (toroidal)
      boid.x = ((boid.x % w) + w) % w;
      boid.y = ((boid.y % h) + h) % h;

      // Record trail point
      if (this.params.showTrails) {
        const maxTrail = 12;
        if (boid.trail.length < maxTrail) {
          boid.trail.push({ x: boid.x, y: boid.y });
        } else {
          boid.trail[boid.trailIdx] = { x: boid.x, y: boid.y };
        }
        boid.trailIdx = (boid.trailIdx + 1) % maxTrail;
      }
    }
  }

  /* ── Render ───────────────────────────────────────────────── */

  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const maxSpeed = this.params.maxSpeed;
    const now = performance.now();

    // Background
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);

    // Trails
    if (this.params.showTrails) {
      this._renderTrails(ctx, maxSpeed);
    }

    // Predator / attractor indicators
    this._renderIndicators(ctx, now, w, h);

    // Boids
    for (let i = 0; i < this.boids.length; i++) {
      const b = this.boids[i];
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const ratio = Math.min(speed / maxSpeed, 1);
      const angle = Math.atan2(b.vy, b.vx);

      const size = 5 + ratio * 3; // faster boids slightly larger

      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(angle);

      // Triangle / arrow shape
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.6, size * 0.45);
      ctx.lineTo(-size * 0.35, 0);
      ctx.lineTo(-size * 0.6, -size * 0.45);
      ctx.closePath();

      ctx.fillStyle = velocityColor(ratio);
      ctx.fill();

      // Subtle glow for faster boids
      if (ratio > 0.6) {
        ctx.shadowColor = velocityColor(ratio);
        ctx.shadowBlur = 4 + ratio * 6;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      ctx.restore();
    }
  }

  _renderTrails(ctx, maxSpeed) {
    for (const b of this.boids) {
      const trail = b.trail;
      if (trail.length < 2) continue;

      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const ratio = Math.min(speed / maxSpeed, 1);

      const len = trail.length;
      // Read trail from oldest to newest using the circular-buffer index
      for (let j = 1; j < len; j++) {
        const idxPrev = (b.trailIdx + j - 1) % len;
        const idxCurr = (b.trailIdx + j) % len;
        const prev = trail[idxPrev];
        const curr = trail[idxCurr];

        // Skip if the segment wraps around the screen edge
        if (Math.abs(curr.x - prev.x) > this.canvas.width * 0.5) continue;
        if (Math.abs(curr.y - prev.y) > this.canvas.height * 0.5) continue;

        const alpha = (j / len) * 0.35;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(curr.x, curr.y);
        ctx.strokeStyle = velocityColorAlpha(ratio, alpha);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  _renderIndicators(ctx, now, w, h) {
    // Predators - pulsing red rings
    for (const pred of this.predators) {
      const age = (now - pred.born) / pred.duration;
      const fade = 1 - age;
      const pulseR = 20 + age * 130;

      ctx.beginPath();
      ctx.arc(pred.x, pred.y, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 60, 80, ${fade * 0.5})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Inner dot
      ctx.beginPath();
      ctx.arc(pred.x, pred.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 60, 80, ${fade * 0.9})`;
      ctx.fill();
    }

    // Attractors - pulsing cyan rings
    for (const att of this.attractors) {
      const age = (now - att.born) / att.duration;
      const fade = 1 - age;
      const pulseR = 15 + age * 100;

      ctx.beginPath();
      ctx.arc(att.x, att.y, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0, 230, 255, ${fade * 0.4})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Inner dot
      ctx.beginPath();
      ctx.arc(att.x, att.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 230, 255, ${fade * 0.9})`;
      ctx.fill();
    }
  }
}
