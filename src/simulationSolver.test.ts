import { describe, expect, it } from 'vitest';
import { oceanMask, runSimulation } from './simulationSolver';
import type { SimulationConfig, TerrainGrid } from './simulationTypes';
const config: SimulationConfig = { lon: 0.5, lat: 0.5, heightM: 1, radiusKm: 5, durationMinutes: 1, domain: 'regional' };
function terrain(w = 41, z: (x: number, y: number) => number = () => -100): TerrainGrid {
  return { width: w, height: w, west: 0, south: 0, step: 1 / (w - 1), elevation: Float32Array.from({ length: w*w }, (_, i) => z(i % w, Math.floor(i / w))) };
}
describe('experimental shallow-water solver: physical invariants', () => {
  it('preserves a still sea over irregular bathymetry including a dry shoreline', () => {
    const grid = terrain(31, (x,y) => x > 23 ? 20 : -50 - ((x * 7 + y * 11) % 50));
    const r = runSimulation(grid, { ...config, heightM: 0, durationMinutes: 5 });
    expect(Math.max(...r.maxSurface)).toBeLessThan(1e-8);
    expect(Math.max(...r.maxDepth)).toBe(0);
  });
  it('keeps an enclosed below-sea-level basin dry', () => {
    const grid = terrain(21, (x,y) => x > 7 && x < 13 && y > 7 && y < 13 ? -5 : x > 5 && x < 15 && y > 5 && y < 15 ? 100 : -100);
    expect(oceanMask(grid)[10*21+10]).toBe(0);
    const r = runSimulation(grid, { ...config, lon: 0.15, lat: 0.15, durationMinutes: 5 });
    expect(r.maxDepth[10*21+10]).toBe(0);
  });
  it('maintains nonnegative finite depths and bilateral symmetry of a centered wave', () => {
    const r = runSimulation(terrain(), { ...config, heightM: 50, durationMinutes: 5 });
    expect([...r.maxDepth, ...r.maxSurface].every(v => Number.isFinite(v) && v >= 0)).toBe(true);
    for (let y = 0; y < 41; y++) for (let x = 0; x < 41; x++) {
      expect(r.maxSurface[y*41+x]).toBeCloseTo(r.maxSurface[y*41+40-x], 5);
      expect(r.maxSurface[y*41+x]).toBeCloseTo(r.maxSurface[(40-y)*41+x], 5);
    }
  });
  it('transports the wave outward with larger response than its initial far-field tail', () => {
    const grid = terrain(61);
    const r = runSimulation(grid, { ...config, durationMinutes: 10 });
    // At 18.6 km from the center, a 100 m sea has long-wave travel time about 10 min.
    const i = 30*61+40;
    const initial = Math.exp(-0.5 * (10 * grid.step * 111320 / 5000) ** 2);
    expect(r.maxSurface[i]).toBeGreaterThan(initial * 5);
    expect(r.elapsedSec).toBe(600);
    expect(r.steps).toBeGreaterThan(1);
  });
  it('prevents transmission across a dry high barrier', () => {
    const grid = terrain(41, x => x === 20 ? 100 : -100);
    const r = runSimulation(grid, { ...config, lon: 0.2, radiusKm: 1, durationMinutes: 5 });
    expect(r.maxDepth[20*41+20]).toBe(0);
    expect(r.maxSurface[20*41+30]).toBeLessThan(1e-8);
  });
  it('does not initialize a tsunami across a land wall in another sea basin', () => {
    const grid = terrain(41, x => x === 20 ? 100 : -100);
    const r = runSimulation(grid, {...config,lon:.45,heightM:50,radiusKm:20,durationMinutes:1/60});
    expect(r.maxSurface[20*41+22]).toBeLessThan(1e-8);
    expect(r.maxSurface[20*41+18]).toBeCloseTo(50, 4);
  });
  it('does not shortcut a peninsula when the water path exceeds the source radius', () => {
    const grid = terrain(41, (x,y) => x === 20 && y < 36 ? 100 : -100);
    const r = runSimulation(grid, {...config,lon:.45,heightM:50,radiusKm:10,durationMinutes:1/60});
    expect(r.ocean[20*41+22]).toBe(1);
    expect(r.maxSurface[20*41+22]).toBeLessThan(1e-8);
  });
  it('accepts 50m and rejects values above the configured limit', () => {
    expect(runSimulation(terrain(), {...config,heightM:50}).elapsedSec).toBe(60);
    expect(()=>runSimulation(terrain(), {...config,heightM:50.1})).toThrow(/範囲外/);
  });
  it('rejects land, outside-domain and nonfinite inputs', () => {
    expect(() => runSimulation(terrain(21, () => 1), config)).toThrow(/海域/);
    expect(() => runSimulation(terrain(), { ...config, lon: 2 })).toThrow(/範囲外/);
    expect(() => runSimulation(terrain(), { ...config, heightM: NaN })).toThrow(/範囲外/);
    const grid = terrain(); grid.elevation[0] = NaN;
    expect(() => runSimulation(grid, config)).toThrow(/地形/);
  });
});
