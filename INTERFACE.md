# Simulation Module Interface Spec

Each simulation module must export a single class as default.
All modules follow this exact interface:

```javascript
export default class SimulationName {
  // canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.params = {}; // internal state
    this.running = false;
  }

  // Initialize/reset the simulation with default params
  init() {}

  // Advance simulation by one step. dt = delta time in ms
  update(dt) {}

  // Draw current state to canvas
  render() {}

  // Handle mouse/touch interaction at canvas coords (x, y)
  handleClick(x, y) {}

  // Handle canvas resize
  handleResize(width, height) {}

  // Return array of adjustable parameters:
  // [{ name: string, label: string, type: 'range'|'color'|'checkbox',
  //    min?: number, max?: number, step?: number, value: any }]
  getParams() { return []; }

  // Update a parameter value
  setParam(name, value) {}

  // Reset to initial state
  reset() { this.init(); }

  // Cleanup
  destroy() {}
}
```

## Important Notes
- Use ES modules (export default class)
- Canvas size will be provided by the shell (typically full viewport minus sidebar)
- Use requestAnimationFrame-friendly patterns
- All rendering goes through the provided ctx (2D context)
- Performance matters: aim for 60fps with reasonable particle/cell counts
- Color scheme: use vibrant colors on dark backgrounds (#0a0a0f base)
- No external dependencies - vanilla JS only
