import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeTerrain, selectGrid } from './simulationTerrain';
import type { SimulationConfig } from './simulationTypes';
const config: SimulationConfig = { lon: 135, lat: 33, heightM: 5, radiusKm: 40, durationMinutes: 20, domain: 'regional' };
const grid = { width: 561, height: 441, west: 122, south: 24, step: .05,
  elevation: Float32Array.from({length: 561 * 441}, (_, i) => i) };
const metadata = { version: 1, width: 561, height: 441, west: 122, south: 24, step: .05,
  encoding: 'int16-le', order: 'south-to-north,row-major', registration: 'cell-center', units: 'm',
  byteLength: 561 * 441 * 2, sha256: '0'.repeat(64), file: 'etopo1-japan-3min.bin' };
afterEach(() => vi.unstubAllGlobals());
describe('terrain domain selection', () => {
  it('retains center coordinates and real source node samples at national stride', () => {
    const out = selectGrid(grid, {...config, domain: 'national'});
    expect([out.width, out.height, out.west, out.south, out.step]).toEqual([281, 221, 122, 24, .1]);
    expect(out.elevation[282]).toBe(grid.elevation[1124]);
    expect(out.elevation.at(-1)).toBe(grid.elevation.at(-1));
  });
  it('selects aligned regional cells within ±3 degrees, south first', () => {
    const out = selectGrid(grid, config);
    expect([out.width, out.height, out.west, out.south, out.step]).toEqual([121, 121, 132, 30, .05]);
    expect(out.elevation[0]).toBe(grid.elevation[120 * 561 + 200]);
  });
  it('clips near the data edge instead of inventing outside elevations', () => {
    const out = selectGrid(grid, {...config, lon: 122, lat: 24});
    expect([out.width, out.height, out.west, out.south]).toEqual([61, 61, 122, 24]);
  });
  it('rejects out-of-range or invalid source coordinates', () => {
    for (const lon of [NaN, Infinity, 151, 121]) expect(() => selectGrid(grid, {...config, lon})).toThrow();
  });
});
describe('terrain integrity and retry', () => {
  it('rejects malformed dimensions before using bytes', async () => {
    await expect(decodeTerrain({...metadata, width: 560}, new ArrayBuffer(metadata.byteLength))).rejects.toThrow('形状');
    await expect(decodeTerrain(metadata, new ArrayBuffer(4))).rejects.toThrow('バイト長');
  });
  it('rejects corrupted payload checksums', async () => {
    await expect(decodeTerrain(metadata, new ArrayBuffer(metadata.byteLength))).rejects.toThrow('検査値');
  });
  it('reads negative little-endian depths and detects source missing values', async () => {
    const buffer = new ArrayBuffer(metadata.byteLength);
    new DataView(buffer).setInt16(0, -5123, true);
    const hash = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
    const decoded = await decodeTerrain({...metadata, sha256: await hash()}, buffer);
    expect(decoded.elevation[0]).toBe(-5123);
    new DataView(buffer).setInt16(0, 32767, true);
    await expect(decodeTerrain({...metadata, sha256: await hash()}, buffer)).rejects.toThrow('欠損');
  });
  it('allows a new fetch after a failure', async () => {
    vi.resetModules();
    const {loadTerrain} = await import('./simulationTerrain');
    const fetcher = vi.fn().mockResolvedValue({ok: false, status: 503});
    vi.stubGlobal('fetch', fetcher);
    await expect(loadTerrain()).rejects.toThrow('503');
    await expect(loadTerrain()).rejects.toThrow('503');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
