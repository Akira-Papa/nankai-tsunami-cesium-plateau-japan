import { describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('cesium', () => ({
  SingleTileImageryProvider: { fromUrl: fake.load },
  Rectangle: { fromDegrees: (...values: number[]) => values },
  Cartesian3: { fromDegreesArray: (values: number[]) => values, fromDegrees: (...values: number[]) => values },
  Cartesian2: class {}, Color: { WHITE: {}, fromCssColorString: (v: string) => v },
  ImageryLayer: class {}, TextureMinificationFilter: { NEAREST: 1 }, TextureMagnificationFilter: { NEAREST: 1 },
}));
import { createSimulationLayer, inspectSimulation, LAND_COLORS, OCEAN_COLORS, simulationBounds, simulationCellIndex, simulationColor, simulationPixels } from './simulationLayer';
import type { SimulationResult } from './simulationTypes';
const result: SimulationResult = {
  grid: { width: 2, height: 2, west: 130, south: 30, step: 0.1, elevation: new Float32Array([-5, 1, -10, -2]) },
  maxSurface: new Float32Array([1, 0, 3, 0]), maxDepth: new Float32Array([6, 0.3, 13, 0]),
  finalDepth: new Float64Array([6, 0.3, 13, 0]), ocean: new Uint8Array([1, 0, 1, 0]), elapsedSec: 600, steps: 100,
};
describe('dynamic simulation map semantics', () => {
  it('treats west/south as centers and uses half-open cell footprints', () => {
    const [w, s, e, n] = simulationBounds(result.grid);
    expect(w).toBeCloseTo(129.95); expect(s).toBeCloseTo(29.95);
    expect(e).toBeCloseTo(130.15); expect(n).toBeCloseTo(30.15);
    expect(simulationCellIndex(result.grid, w, s)).toBe(0);
    expect(simulationCellIndex(result.grid, w + 0.1, s)).toBe(1);
    expect(simulationCellIndex(result.grid, w + 0.1 - 1e-7, s)).toBe(0);
    expect(simulationCellIndex(result.grid, w, s + 0.1)).toBe(2);
    expect(simulationCellIndex(result.grid, 130.1, 30.1)).toBe(3);
    expect(simulationCellIndex(result.grid, e, 30)).toBeNull();
    expect(simulationCellIndex(result.grid, 130, n)).toBeNull();
    expect(simulationCellIndex(result.grid, w - 1e-7, s)).toBeNull();
    expect(simulationCellIndex(result.grid, NaN, 30)).toBeNull();
  });
  it('uses different ocean and land palettes with stable numeric thresholds', () => {
    for (const value of [0, -1, 0.01, NaN, Infinity]) expect(simulationColor(value, true)).toBeNull();
    expect(simulationColor(0.0101, true)).toBe(OCEAN_COLORS[0]);
    expect(simulationColor(0.1, true)).toBe(OCEAN_COLORS[1]);
    expect(simulationColor(1, true)).toBe(OCEAN_COLORS[3]);
    expect(simulationColor(10, false)).toBe(LAND_COLORS[5]);
    expect(simulationColor(30, false)).toBe(LAND_COLORS[7]);
    expect(simulationColor(50, true)).toBe(OCEAN_COLORS[8]);
    expect(simulationColor(0.3, false)).toBe(LAND_COLORS[2]);
  });
  it('flips south-first rows so north is at the top and uses ocean mask', () => {
    const pixels = simulationPixels(result);
    expect(Array.from(pixels.slice(0, 4))).toEqual([22, 74, 171, 210]); // North-west ocean 3m, not 13m depth
    expect(Array.from(pixels.slice(4, 8))).toEqual([0, 0, 0, 0]); // Negative land, not ocean
    expect(Array.from(pixels.slice(8, 12))).toEqual([22, 121, 203, 210]); // South-west ocean 1m
    expect(pixels[15]).toBe(210);
  });
  it('describes land depth and offshore surface against distinct datums', () => {
    expect(inspectSimulation(result, 130, 30)).toContain('最大水位上昇（海面基準） 1.00');
    expect(inspectSimulation(result, 130.1, 30)).toContain('最大浸水深（地盤から） 0.30');
    const dry = inspectSimulation(result, 130.1, 30.1);
    expect(dry).toContain('地形標高 -2.0'); expect(dry).toContain('閾値 0.01 m 以下');
    expect(dry).toContain('安全や建物ごとの浸水を判定できません');
    expect(inspectSimulation(result, 140, 40)).toContain('領域外・未計算');
    expect(inspectSimulation(null, 130, 30)).toContain('未計算');
  });
});

describe('asynchronous imagery lifecycle', () => {
  it('never installs a stale image after replacement, clear, or dispose', async () => {
    const resolvers: Array<(value: object) => void> = [];
    fake.load.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: vi.fn() }),
      toDataURL: () => 'data:image/png;base64,test' }) });
    const add = vi.fn(), remove = vi.fn();
    const viewer = { imageryLayers: { add, remove }, entities: { add: vi.fn(() => ({})), remove: vi.fn() },
      scene: { requestRender: vi.fn() }, isDestroyed: () => false };
    const layer = createSimulationLayer(viewer as unknown as Parameters<typeof createSimulationLayer>[0]);
    try {
      layer.setResult(result); layer.setResult(result);
      resolvers[0]({}); await Promise.resolve();
      expect(add).not.toHaveBeenCalled();
      resolvers[1]({}); await Promise.resolve();
      expect(add).toHaveBeenCalledTimes(1);
      layer.clear(); expect(remove).toHaveBeenCalledTimes(1);
      expect(layer.inspect(130, 30)).toContain('未計算');
      layer.setResult(result); layer.dispose();
      resolvers[2]({}); await Promise.resolve();
      expect(add).toHaveBeenCalledTimes(1);
      layer.setResult(result); expect(resolvers).toHaveLength(3);
    } finally { vi.unstubAllGlobals(); }
  });
});
