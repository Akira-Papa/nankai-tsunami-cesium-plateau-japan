import { describe, expect, it } from 'vitest';
import { runSimulation } from './simulationSolver';
import type { SimulationConfig, TerrainGrid } from './simulationTypes';

const config: SimulationConfig = { lon: 0, lat: 0, heightM: .01, radiusKm: 3, durationMinutes: 2, domain: 'regional' };
function flatGrid(width: number): TerrainGrid {
  return { width, height: width, west: -.3, south: -.3, step: .6 / (width - 1), elevation: new Float32Array(width * width).fill(-100) };
}
// Independent continuum checks: in a constant-depth ocean linear SWE has
// M''(t) = 4 g H volume for the radial second moment; initial velocity is zero.
// Thus the normalized second-moment increment is 2 g H t², not a formula copied
// from the finite-volume numerical flux. Boundaries are > 10 source sigmas away.
function moments(grid: TerrainGrid, depth: Float64Array) {
  const dx = grid.step * 111320;
  let volume = 0, moment = 0;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const eta = depth[y * grid.width + x] + grid.elevation[y * grid.width + x];
    const r2 = ((x - (grid.width - 1) / 2) * dx) ** 2 + ((y - (grid.height - 1) / 2) * dx) ** 2;
    volume += eta; moment += eta * r2;
  }
  return { volume: volume * dx * dx, normalized: moment / volume };
}
function initialDepth(grid: TerrainGrid) {
  return Float64Array.from(grid.elevation, (z, i) => {
    const x = (i % grid.width - (grid.width - 1) / 2) * grid.step * 111320;
    const y = (Math.floor(i / grid.width) - (grid.height - 1) / 2) * grid.step * 111320;
    const r2 = (x*x + y*y) / (config.radiusKm * 1000) ** 2;
    return -z + (r2 <= 36 ? config.heightM * Math.exp(-r2 / 2) : 0);
  });
}

describe('independent continuum physics acceptance', () => {
  it('conserves added water volume before the wave reaches an open boundary', () => {
    const grid = flatGrid(101), before = moments(grid, initialDepth(grid));
    const result = runSimulation(grid, config);
    const after = moments(grid, result.finalDepth);
    expect(Math.abs(after.volume / before.volume - 1)).toBeLessThan(1e-6);
    expect([...result.finalDepth].every(v => Number.isFinite(v) && v >= 0)).toBe(true);
  });
  it('converges toward the analytical long-wave radial spreading rate sqrt(gH)', () => {
    const expected = 2 * 9.81 * 100 * (config.durationMinutes * 60) ** 2;
    const errors = [101, 201].map(width => {
      const grid = flatGrid(width), before = moments(grid, initialDepth(grid));
      const after = moments(grid, runSimulation(grid, config).finalDepth);
      return Math.abs((after.normalized - before.normalized) / expected - 1);
    });
    expect(errors[1]).toBeLessThan(.2); // explicitly allows first-order numerical diffusion
    expect(errors[1]).toBeLessThan(errors[0] * .7);
  });
});

