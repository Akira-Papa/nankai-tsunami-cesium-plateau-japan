import { describe, expect, it, vi } from 'vitest';

// Cesium 本体は node 環境で読み込まないようモック（幾何関数だけを検証する）
vi.mock('cesium', () => ({}));

import { SLIP_REGIONS, STATIONS, regionPolygon, regionCentroid, regionsBBox } from './slipRegions';
import { TSUNAMI_CASES } from './scenarios';

describe('slipRegions 幾何', () => {
  it('全ケースの regionKeys が定義済み区域を指す', () => {
    for (const c of TSUNAMI_CASES) {
      expect(c.regionKeys.length).toBeGreaterThan(0);
      for (const k of c.regionKeys) expect(SLIP_REGIONS[k], `${c.label} ${k}`).toBeDefined();
      // 2箇所ケース（⑧〜⑪）は区域が2つ
      expect(c.regionKeys.length).toBe(c.slipCount);
    }
  });

  it('区域ポリゴンは閉じた環で、断面範囲内にある', () => {
    for (const def of Object.values(SLIP_REGIONS)) {
      const ring = regionPolygon(def);
      expect(ring.length).toBeGreaterThanOrEqual(5);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      const lons = ring.map((p) => p[0]);
      const lats = ring.map((p) => p[1]);
      // 帯の範囲（日向灘〜駿河湾）に収まる
      expect(Math.min(...lons)).toBeGreaterThanOrEqual(131.0);
      expect(Math.max(...lons)).toBeLessThanOrEqual(139.0);
      expect(Math.min(...lats)).toBeGreaterThanOrEqual(30.9);
      expect(Math.max(...lats)).toBeLessThanOrEqual(35.0);
    }
  });

  it('四国沖の重心は土佐湾沖（四国の南）にある', () => {
    const [lon, lat] = regionCentroid(SLIP_REGIONS.shikoku);
    expect(lon).toBeGreaterThan(133.0);
    expect(lon).toBeLessThan(134.6);
    expect(lat).toBeLessThan(33.3); // 高知市（33.56N）より南
    expect(lat).toBeGreaterThan(32.0);
  });

  it('断面は北東→南西に並び、陸側の縁が海溝側より北にある', () => {
    for (let i = 1; i < STATIONS.length; i++) expect(STATIONS[i].coast[0]).toBeLessThan(STATIONS[i - 1].coast[0]);
    for (const st of STATIONS) expect(st.coast[1]).toBeGreaterThan(st.trough[1]);
  });

  it('regionsBBox は複数区域を包含し、空なら null', () => {
    expect(regionsBBox([])).toBeNull();
    const b = regionsBBox(['muroto', 'hyuganada'])!;
    const m = regionsBBox(['muroto'])!;
    const h = regionsBBox(['hyuganada'])!;
    expect(b[0]).toBe(Math.min(m[0], h[0]));
    expect(b[2]).toBe(Math.max(m[2], h[2]));
  });
});
