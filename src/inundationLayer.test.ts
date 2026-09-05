import { describe, expect, it, vi } from 'vitest';
vi.mock('cesium', () => ({}));
import { cellBounds, cellVisible, depthColor, validCell, DEPTH_COLORS } from './inundationLayer';
const cell = { lon: 136.9, lat: 35.1, sizeM: 10, depthM: 3, arrivalSec: 600 };
describe('computed inundation semantics', () => {
  it('uses maximum depth palette with exact threshold boundaries', () => {
    expect(depthColor(0.299)).toBe(DEPTH_COLORS[0]);
    expect(depthColor(0.3)).toBe(DEPTH_COLORS[1]);
    expect(depthColor(3)).toBe(DEPTH_COLORS[4]);
    expect(depthColor(20)).toBe(DEPTH_COLORS[7]);
    expect(depthColor(NaN)).toBe('transparent');
    expect(depthColor(0)).toBe('transparent');
  });
  it('includes arrival threshold but never treats missing arrival as time zero', () => {
    const state = { mode: 'arrival' as const, minutes: 10, opacity: 0.7 };
    expect(cellVisible(cell, state)).toBe(true);
    expect(cellVisible(cell, { ...state, minutes: 9.99 })).toBe(false);
    for (const arrivalSec of [null, NaN, Infinity, -1]) expect(cellVisible({ ...cell, arrivalSec }, state)).toBe(false);
    expect(cellVisible({ ...cell, arrivalSec: null }, { ...state, mode: 'max' })).toBe(true);
  });
  it('rejects invalid depth and location', () => {
    expect(validCell(cell)).toBe(true);
    for (const depthM of [0, -1, Infinity, NaN]) expect(validCell({ ...cell, depthM })).toBe(false);
    expect(validCell({ ...cell, lat: NaN })).toBe(false);
    expect(validCell({ ...cell, sizeM: 0 })).toBe(false);
  });
  it('converts metres with latitude-dependent longitude width', () => {
    const south = cellBounds({ ...cell, lat: 25, sizeM: 1000 });
    const north = cellBounds({ ...cell, lat: 45, sizeM: 1000 });
    expect(north[2] - north[0]).toBeGreaterThan(south[2] - south[0]);
    const [w, s, e, n] = cellBounds(cell);
    expect((w + e) / 2).toBeCloseTo(cell.lon, 10);
    expect((s + n) / 2).toBeCloseTo(cell.lat, 10);
    expect(n - s).toBeGreaterThan(0.000089);
    expect(n - s).toBeLessThan(0.000091);
  });
});
