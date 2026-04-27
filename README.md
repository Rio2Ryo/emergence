# EMERGENCE

**Interactive Artificial Life Laboratory** -- real-time simulations of emergent behavior rendered on HTML Canvas with ambient audio synthesis.

[Live Demo](https://emergence-mu.vercel.app)

![Screenshot placeholder -- replace with actual screenshot](screenshot.png)

---

## Features

- **Particle Life** -- Self-organising particle systems governed by attraction/repulsion matrices between color species
- **Boids** -- Classic flocking simulation with separation, alignment, and cohesion rules
- **Game of Life** -- Conway's cellular automaton with interactive cell painting
- **Langton's Ant** -- Simple Turing-complete ant on a grid producing emergent highway patterns
- **Reaction-Diffusion** -- Gray-Scott model generating organic spots, stripes, and coral-like structures

Additional capabilities:
- Ambient audio synthesis (Web Audio API) that reacts to the simulation state
- Real-time parameter tuning via sidebar controls
- Fullscreen mode and canvas screenshots
- Responsive layout for desktop and mobile

## Controls

| Input | Action |
|---|---|
| `1`-`4` | Switch between simulations |
| `Space` | Pause / Resume |
| `R` | Reset current simulation |
| `M` | Toggle ambient audio |
| `F` | Toggle fullscreen |
| Click canvas | Simulation-specific interaction (add particles, toggle cells, etc.) |

## Tech Stack

- **Vanilla JavaScript** (ES modules, no framework)
- **Canvas 2D API** for rendering
- **Web Audio API** for ambient audio synthesis (oscillators, filters, delay)
- **CSS custom properties** for theming
- Deployed on **Vercel**

## Project Structure

```
emergence/
  index.html          App shell and boot sequence
  css/style.css       Dark cyberpunk theme
  js/
    app.js            Orchestrator, audio system, UI controls
    particle-life.js  Particle Life simulation
    boids.js          Boids flocking simulation
    game-of-life.js   Conway's Game of Life
    langton.js        Langton's Ant
```

## Running Locally

Serve the project root with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000` (or whichever port) in a modern browser.

## License

MIT
