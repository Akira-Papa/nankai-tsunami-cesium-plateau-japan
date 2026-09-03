import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Cesium をモック（node では WebGL が無いため。マネージャが使う API だけを最小実装）
// ---------------------------------------------------------------------------
const { deferred, FakeEvent, FakeTileset, FakeShader, FakeCartesian3, pending } = vi.hoisted(() => {
  type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
  function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  class FakeEvent {
    fns = new Set<() => void>();
    addEventListener(fn: () => void) { this.fns.add(fn); return () => this.fns.delete(fn); }
    removeEventListener(fn: () => void) { return this.fns.delete(fn); }
  }
  class FakeTileset {
    show = true;
    customShader: unknown = undefined;
    destroyed = false;
    loadProgress = new FakeEvent();
    allTilesLoaded = new FakeEvent();
    constructor(public url: string) {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  class FakeShader {
    uniforms: Record<string, { value: unknown }>;
    set: Record<string, unknown> = {};
    constructor(o: { uniforms: Record<string, { value: unknown }> }) { this.uniforms = o.uniforms; }
    setUniform(name: string, v: unknown) { this.set[name] = v; }
  }
  class FakeCartesian3 {
    constructor(public x = 0, public y = 0, public z = 0) {}
    static fromDegrees(lon: number, lat: number, h: number) { return new FakeCartesian3(lon, lat, h); }
    static subtract(a: FakeCartesian3, b: FakeCartesian3, out: FakeCartesian3) { out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z; return out; }
  }

  const pending: { url: string; d: Deferred<FakeTileset>; opts: unknown }[] = [];
  return { deferred, FakeEvent, FakeTileset, FakeShader, FakeCartesian3, pending };
});
type FakeTileset = InstanceType<typeof FakeTileset>;
type FakeShader = InstanceType<typeof FakeShader>;
type FakeCartesian3 = InstanceType<typeof FakeCartesian3>;

vi.mock('cesium', () => ({
  Cesium3DTileset: {
    fromUrl: vi.fn((url: string, opts: unknown) => {
      const d = deferred<FakeTileset>();
      pending.push({ url, d, opts });
      return d.promise;
    }),
  },
  CustomShader: FakeShader,
  CustomShaderMode: { MODIFY_MATERIAL: 'MODIFY_MATERIAL' },
  LightingModel: { PBR: 'PBR' },
  UniformType: { FLOAT: 'FLOAT', VEC3: 'VEC3' },
  Cartesian3: FakeCartesian3,
  Ellipsoid: { WGS84: { geodeticSurfaceNormal: (_p: unknown, out: FakeCartesian3) => { out.z = 1; return out; } } },
}));

import type * as Cesium from 'cesium';
import {
  Lru, bboxCenter, createTilesetManager, expandRect, groupKey, prioritize, rectIntersects, selectEntries,
  type Bbox, type PlateauRegistry, type PlateauTilesetEntry,
} from './tilesetManager';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------
function entry(p: Partial<PlateauTilesetEntry> & { url: string }): PlateauTilesetEntry {
  return {
    city_code: '23100', city: '名古屋市', pref_code: '23', pref: '愛知県', ward_code: null, ward: null,
    lod: 1, texture: true, year: 2022, bbox: [136.8, 35.0, 136.9, 35.1], ...p,
  };
}
const NAGOYA_MINATO_L1 = entry({ url: 'u/minato-l1', ward_code: '23111', ward: '港区', bbox: [136.79, 35.03, 136.91, 35.13] });
const NAGOYA_MINATO_L2 = entry({ url: 'u/minato-l2', ward_code: '23111', ward: '港区', lod: 2, texture: false, bbox: [136.79, 35.03, 136.91, 35.13] });
const NAGOYA_MINATO_L2T = entry({ url: 'u/minato-l2t', ward_code: '23111', ward: '港区', lod: 2, texture: true, bbox: [136.79, 35.03, 136.91, 35.13] });
const NAGOYA_MINAMI_L1 = entry({ url: 'u/minami-l1', ward_code: '23112', ward: '南区', bbox: [136.90, 35.07, 136.95, 35.12] });
const KOCHI_L1_2020 = entry({ url: 'u/kochi-l1-2020', city_code: '39201', city: '高知市', pref_code: '39', pref: '高知県', year: 2020, bbox: [133.48, 33.53, 133.57, 33.58] });
const KOCHI_L1_2023 = entry({ url: 'u/kochi-l1-2023', city_code: '39201', city: '高知市', pref_code: '39', pref: '高知県', year: 2023, bbox: [133.48, 33.53, 133.57, 33.58] });
const KOCHI_L2_2020 = entry({ url: 'u/kochi-l2-2020', city_code: '39201', city: '高知市', pref_code: '39', pref: '高知県', year: 2020, lod: 2, texture: false, bbox: [133.48, 33.53, 133.57, 33.58] });
const NAHA_L1 = entry({ url: 'u/naha-l1', city_code: '47201', city: '那覇市', pref_code: '47', pref: '沖縄県', year: 2020, bbox: [127.64, 26.17, 127.74, 26.25] });
const NOBBOX = entry({ url: 'u/nobbox', city_code: '30201', city: '和歌山市', bbox: null });
const BAD_STATUS = entry({ url: 'u/404', city_code: '36201', city: '徳島市', bbox: [134.42, 33.95, 134.60, 34.13], http_status: 404 });
const ALL = [NAGOYA_MINATO_L1, NAGOYA_MINATO_L2, NAGOYA_MINATO_L2T, NAGOYA_MINAMI_L1, KOCHI_L1_2020, KOCHI_L1_2023, KOCHI_L2_2020, NAHA_L1, NOBBOX, BAD_STATUS];

// ---------------------------------------------------------------------------
// 純粋ロジック
// ---------------------------------------------------------------------------
describe('rectIntersects / expandRect', () => {
  it('交差・接触・分離を判定する', () => {
    expect(rectIntersects([0, 0, 1, 1], [0.5, 0.5, 2, 2])).toBe(true);
    expect(rectIntersects([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true); // 辺で接触
    expect(rectIntersects([0, 0, 1, 1], [1.01, 0, 2, 1])).toBe(false);
    expect(rectIntersects([0, 0, 1, 1], [0, 1.01, 1, 2])).toBe(false);
    expect(rectIntersects([0, 0, 1, 1], [0.2, 0.2, 0.3, 0.3])).toBe(true); // 包含
  });
  it('20 % 拡張は各辺に幅・高さの 20 % を足す', () => {
    const r = expandRect([10, 20, 20, 25], 0.2);
    expect(r).toEqual([8, 19, 22, 26]);
    expect(bboxCenter(r)).toEqual({ lon: 15, lat: 22.5 });
  });
});

describe('selectEntries', () => {
  it('市区ごとに最新 year・LOD1 を選び、bbox なし／http_status≠200 を除外する', () => {
    const sel = selectEntries(ALL, false);
    const byGroup = new Map(sel.map((e) => [groupKey(e), e]));
    expect(byGroup.get('23111')?.url).toBe('u/minato-l1');
    expect(byGroup.get('23112')?.url).toBe('u/minami-l1');
    expect(byGroup.get('39201')?.url).toBe('u/kochi-l1-2023'); // 2020 より 2023
    expect(byGroup.get('47201')?.url).toBe('u/naha-l1');
    expect(byGroup.has('30201')).toBe(false); // bbox null
    expect(byGroup.has('36201')).toBe(false); // 404
  });
  it('lod2=true では LOD2（テクスチャなし優先）、無ければ LOD1 へフォールバックする', () => {
    const sel = selectEntries(ALL, true);
    const byGroup = new Map(sel.map((e) => [groupKey(e), e]));
    expect(byGroup.get('23111')?.url).toBe('u/minato-l2'); // notex 優先（l2t ではない）
    expect(byGroup.get('23112')?.url).toBe('u/minami-l1'); // LOD2 なし → LOD1
    // 高知: 最新 2023 には LOD1 しかない → 旧年度 LOD2 ではなく最新年度 LOD1
    expect(byGroup.get('39201')?.url).toBe('u/kochi-l1-2023');
  });
  it('視野矩形と交差する市区だけを返す', () => {
    const view: Bbox = [136.85, 35.0, 136.95, 35.2];
    const sel = selectEntries(ALL, false, view).map(groupKey).sort();
    expect(sel).toEqual(['23111', '23112']);
    expect(selectEntries(ALL, false, [140, 40, 141, 41])).toEqual([]);
  });
  it('prioritize は視野中心に近い順に上限件数へ絞る', () => {
    const sel = selectEntries(ALL, false);
    const top = prioritize(sel, { lon: 136.93, lat: 35.1 }, 2).map(groupKey);
    expect(top).toEqual(['23112', '23111']);
    expect(prioritize(sel, { lon: 133.5, lat: 33.55 }, 1).map(groupKey)).toEqual(['39201']);
  });
});

describe('Lru', () => {
  it('容量超過で最古を evict し、take は順序から外す', () => {
    const evicted: string[] = [];
    const lru = new Lru<string, number>(2, (k) => evicted.push(k));
    lru.put('a', 1); lru.put('b', 2); lru.put('c', 3);
    expect(evicted).toEqual(['a']);
    expect(lru.take('b')).toBe(2);
    expect(lru.has('b')).toBe(false);
    lru.put('d', 4); lru.put('e', 5);
    expect(evicted).toEqual(['a', 'c']);
    expect(lru.keys()).toEqual(['d', 'e']);
  });
  it('容量 0 は即 evict', () => {
    const evicted: string[] = [];
    const lru = new Lru<string, number>(0, (k) => evicted.push(k));
    lru.put('a', 1);
    expect(evicted).toEqual(['a']);
    expect(lru.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createTilesetManager（フェイク Viewer）
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;
function makeViewer(init: { rect: Bbox; height: number }) {
  const state = { rect: init.rect, height: init.height, rectAvailable: true };
  const primitives: unknown[] = [];
  const preRender = new FakeEvent();
  let renders = 0;
  const viewer = {
    camera: {
      computeViewRectangle: () => state.rectAvailable
        ? { west: state.rect[0] * DEG, south: state.rect[1] * DEG, east: state.rect[2] * DEG, north: state.rect[3] * DEG }
        : undefined,
      get positionCartographic() {
        const c = bboxCenter(state.rect);
        return { longitude: c.lon * DEG, latitude: c.lat * DEG, height: state.height };
      },
      positionWC: new FakeCartesian3(1, 2, 3),
    },
    scene: {
      primitives: {
        add: (p: unknown) => { primitives.push(p); return p; },
        remove: (p: unknown) => { const i = primitives.indexOf(p); if (i < 0) return false; primitives.splice(i, 1); (p as FakeTileset).destroy(); return true; },
      },
      preRender,
      requestRender: () => { renders++; },
    },
  };
  return { viewer: viewer as unknown as Cesium.Viewer, state, primitives, preRender, renders: () => renders };
}

/** pending の中から URL 一致の読込を完了させる */
async function resolveLoad(url: string) {
  const i = pending.findIndex((p) => p.url === url);
  if (i < 0) throw new Error(`no pending load for ${url}`);
  const [p] = pending.splice(i, 1);
  p.d.resolve(new FakeTileset(url));
  await flush();
}
async function rejectLoad(url: string) {
  const i = pending.findIndex((p) => p.url === url);
  const [p] = pending.splice(i, 1);
  p.d.reject(new Error('HTTP 404'));
  await flush();
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const registry: PlateauRegistry = { generated: '2026-09-02', source: 'test', tilesets: ALL };

beforeEach(() => { pending.length = 0; });

describe('createTilesetManager', () => {
  it('視野内の市区だけを maxConcurrent 本ずつ読み込み、状態文を通知する', async () => {
    const statuses: string[] = [];
    const { viewer, primitives } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 1, lod2: false, onStatus: (t) => statuses.push(t), mobile: false });
    m.update();
    expect(pending.map((p) => p.url)).toEqual(['u/minami-l1']); // 中心に近い南区が先、同時 1 本
    expect(m.stats()).toEqual({ loaded: 0, loading: 2 });
    expect(statuses.at(-1)).toBe('建物: 0都市 表示（読込中 2）');

    await resolveLoad('u/minami-l1');
    expect(pending.map((p) => p.url)).toEqual(['u/minato-l1']);
    expect(m.stats()).toEqual({ loaded: 1, loading: 1 });
    await resolveLoad('u/minato-l1');
    expect(m.stats()).toEqual({ loaded: 2, loading: 0 });
    expect(primitives).toHaveLength(2);
    expect(statuses.at(-1)).toBe('建物: 1都市 表示'); // 名古屋 2 区 = 1 都市
    // 各 tileset に個別シェーダが付き、ENU 原点は bbox 中心
    const ts = primitives[0] as FakeTileset;
    expect(ts.customShader).toBeInstanceOf(FakeShader);
    expect((ts.customShader as FakeShader).uniforms.u_waterHeight.value).toBe(0);
  });

  it('デスクトップは maximumScreenSpaceError 16、モバイルは 24 / 48 MB / 16 MB / skipLOD を渡す', () => {
    const mk = (mobile: boolean) => {
      const { viewer } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
      createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile }).update();
      return pending.splice(0, pending.length)[0].opts as Record<string, unknown>;
    };
    expect(mk(true)).toMatchObject({ maximumScreenSpaceError: 24, cacheBytes: 48 * 1024 * 1024, maximumCacheOverflowBytes: 16 * 1024 * 1024, skipLevelOfDetail: true });
    expect(mk(false)).toMatchObject({ maximumScreenSpaceError: 16, skipLevelOfDetail: true });
  });

  it('視野から外れた tileset は LRU へ退避し、溢れたら primitives から除去・destroy する', async () => {
    const { viewer, state, primitives } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile: false, lruSize: 1 });
    m.update();
    await resolveLoad('u/minami-l1');
    await resolveLoad('u/minato-l1');
    const minami = primitives.find((p) => (p as FakeTileset).url === 'u/minami-l1') as FakeTileset;
    const minato = primitives.find((p) => (p as FakeTileset).url === 'u/minato-l1') as FakeTileset;

    // 高知へ移動 → 名古屋 2 件は不要。LRU 容量 1 なので 1 件は退避（非表示）、1 件は destroy
    state.rect = [133.4, 33.5, 133.6, 33.6];
    m.update();
    expect(pending.map((p) => p.url)).toEqual(['u/kochi-l1-2023']);
    const destroyed = [minami, minato].filter((t) => t.destroyed);
    const kept = [minami, minato].filter((t) => !t.destroyed);
    expect(destroyed).toHaveLength(1);
    expect(kept).toHaveLength(1);
    expect(kept[0].show).toBe(false);
    expect(primitives).toContain(kept[0]);
    expect(primitives).not.toContain(destroyed[0]);
    await resolveLoad('u/kochi-l1-2023');
    expect(m.stats()).toEqual({ loaded: 1, loading: 0 });

    // 名古屋へ戻る → LRU に残っていた 1 件は再ダウンロードなしで再表示、もう 1 件だけ再読込
    state.rect = [136.85, 35.0, 136.95, 35.2];
    m.update();
    expect(kept[0].show).toBe(true);
    expect(pending.map((p) => p.url)).toEqual([destroyed[0].url]);
  });

  it('60 km 超では建物を出さず「広域のため非表示」を通知する', async () => {
    const statuses: string[] = [];
    const { viewer, state } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile: false, onStatus: (t) => statuses.push(t) });
    m.update();
    await resolveLoad('u/minami-l1');
    await resolveLoad('u/minato-l1');
    state.height = 80_000;
    m.update();
    expect(statuses.at(-1)).toBe('建物: 広域のため非表示');
    expect(m.stats().loaded).toBe(0);
    expect(pending).toHaveLength(0);
  });

  it('computeViewRectangle が取れない場合はカメラ位置と高度から矩形を近似する', () => {
    const { viewer, state } = makeViewer({ rect: [136.88, 35.07, 136.90, 35.09], height: 3000 });
    state.rectAvailable = false;
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile: false });
    m.update();
    expect(pending.map((p) => p.url).sort()).toEqual(['u/minami-l1', 'u/minato-l1']);
  });

  it('モバイルの表示上限 3 件を守る', () => {
    const many = Array.from({ length: 6 }, (_, i) => entry({ url: `u/w${i}`, ward_code: `2310${i}`, bbox: [136.8 + i * 0.01, 35.0, 136.81 + i * 0.01, 35.1] }));
    const { viewer } = makeViewer({ rect: [136.79, 34.99, 136.9, 35.11], height: 5000 });
    const m = createTilesetManager(viewer, { registry: { ...registry, tilesets: many }, maxConcurrent: 8, lod2: false, mobile: true });
    m.update();
    expect(pending).toHaveLength(3);
    expect(m.stats().loading).toBe(3);
  });

  it('読込失敗は例外にせず状態文へ反映し、以後スキップする', async () => {
    const statuses: string[] = [];
    const { viewer } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile: false, onStatus: (t) => statuses.push(t) });
    m.update();
    await rejectLoad('u/minami-l1');
    await resolveLoad('u/minato-l1');
    expect(statuses.at(-1)).toBe('建物: 1都市 表示／1件 失敗');
    m.update();
    expect(pending).toHaveLength(0); // 失敗 URL は再要求しない
  });

  it('setLod2 で URL が切り替わり、setEnabled(false) で全て非表示になる', async () => {
    const { viewer, primitives } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile: false, lruSize: 6 });
    m.update();
    await resolveLoad('u/minami-l1');
    await resolveLoad('u/minato-l1');
    m.setLod2(true);
    expect(pending.map((p) => p.url)).toEqual(['u/minato-l2']); // 南区は LOD2 なし → そのまま
    await resolveLoad('u/minato-l2');
    const l1 = primitives.find((p) => (p as FakeTileset).url === 'u/minato-l1') as FakeTileset;
    expect(l1.show).toBe(false); // LRU 退避
    expect(m.stats()).toEqual({ loaded: 2, loading: 0 });

    m.setEnabled(false);
    expect(m.stats().loaded).toBe(0);
    expect(primitives.every((p) => (p as FakeTileset).show === false)).toBe(true);
    m.setEnabled(true);
    expect(m.stats().loaded).toBe(2); // LRU から復帰、再読込なし
    expect(pending).toHaveLength(0);
  });

  it('setWaterLevel は tileset ごとに geoidFn(bbox中心)+T.P. を uniform へ入れ、dispose で全て破棄する', async () => {
    const { viewer, primitives, preRender } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile: false });
    expect(preRender.fns.size).toBe(1);
    m.update();
    await resolveLoad('u/minami-l1');
    await resolveLoad('u/minato-l1');
    const geoidFn = vi.fn((lon: number, _lat: number) => (lon > 136.9 ? 40 : 30));
    m.setWaterLevel(99, geoidFn, 3.5);
    const shaders = primitives.map((p) => (p as FakeTileset).customShader as FakeShader);
    const byUrl = new Map(primitives.map((p) => [(p as FakeTileset).url, (p as FakeTileset).customShader as FakeShader]));
    expect(byUrl.get('u/minami-l1')!.set.u_waterHeight).toBe(43.5); // 中心 lon 136.925
    expect(byUrl.get('u/minato-l1')!.set.u_waterHeight).toBe(33.5); // 中心 lon 136.85
    // geoidFn が失敗したら中心値へフォールバック
    m.setWaterLevel(50, () => { throw new Error('boom'); }, 1);
    expect(shaders.every((s) => s.set.u_waterHeight === 50)).toBe(true);
    // preRender で u_camToOrigin が更新される
    for (const fn of preRender.fns) fn();
    expect(shaders.every((s) => s.set.u_camToOrigin instanceof FakeCartesian3)).toBe(true);

    m.dispose();
    expect(primitives).toHaveLength(0);
    expect(preRender.fns.size).toBe(0);
    expect(m.stats()).toEqual({ loaded: 0, loading: 0 });
    m.update(); // 破棄後は no-op
    expect(pending).toHaveLength(0);
  });

  it('読込中に視野から外れた tileset は表示せず LRU へ入れる', async () => {
    const { viewer, state, primitives } = makeViewer({ rect: [136.85, 35.0, 136.95, 35.2], height: 5000 });
    const m = createTilesetManager(viewer, { registry, maxConcurrent: 4, lod2: false, mobile: false, lruSize: 6 });
    m.update();
    state.rect = [127.6, 26.1, 127.8, 26.3]; // 那覇へ
    m.update();
    await resolveLoad('u/minami-l1');
    const minami = primitives.find((p) => (p as FakeTileset).url === 'u/minami-l1') as FakeTileset;
    expect(minami.show).toBe(false);
    expect(m.stats().loaded).toBe(0);
    await resolveLoad('u/naha-l1');
    expect(m.stats()).toEqual({ loaded: 1, loading: 1 }); // 港区はまだ読込中
  });
});

// ---------------------------------------------------------------------------
// catalog.ts / tilesets.ts（レジストリのマージ・最新化・フォールバック）
// ---------------------------------------------------------------------------
import { CATALOG_CACHE_KEY, mergeRegistry, refreshRegistry } from './catalog';
import { FIXTURE_REGISTRY, loadRegistryDetailed, normalizeRegistry } from './tilesets';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

function gqlResponse(code: string, name: string, datasets: unknown[]) {
  return new Response(JSON.stringify({ data: { area: { code, name, prefecture: { code: code.slice(0, 2), name: 'X県' }, datasets } } }), { status: 200 });
}
const item = (lod: number, tex: boolean, url: string) => ({ id: url, lod, texture: tex ? 'TEXTURE' : 'NONE', format: 'CESIUM3DTILES', url, latestUrl: null });

describe('mergeRegistry', () => {
  it('同一キーは URL 差替え、新規は同じ市区の bbox を引き継いで追加、他都市は不変', () => {
    const base = { generated: '', source: 's', tilesets: [NAGOYA_MINATO_L1, KOCHI_L1_2023] };
    const fetched = [
      entry({ url: 'u/minato-l1-NEW', ward_code: '23111', ward: '港区', bbox: null, http_status: undefined }),
      entry({ url: 'u/minato-l2-2024', ward_code: '23111', ward: '港区', lod: 2, texture: false, year: 2024, bbox: null }),
    ];
    const { registry, changed } = mergeRegistry(base, fetched);
    expect(changed).toBe(2);
    expect(registry.tilesets).toHaveLength(3);
    expect(registry.tilesets[0].url).toBe('u/minato-l1-NEW');
    expect(registry.tilesets[0].bbox).toEqual(NAGOYA_MINATO_L1.bbox);
    expect(registry.tilesets[2]).toMatchObject({ url: 'u/minato-l2-2024', year: 2024, bbox: NAGOYA_MINATO_L1.bbox });
    expect(registry.tilesets[1]).toEqual(KOCHI_L1_2023);
    expect(base.tilesets).toHaveLength(2); // 入力は不変
  });
});

describe('refreshRegistry', () => {
  const base: PlateauRegistry = { generated: '', source: 's', tilesets: [NAGOYA_MINATO_L1, { ...KOCHI_L1_2023, url: 'https://x/kochi-l1-2023/tileset.json' }] };

  it('都市ごとに GraphQL を叩いてマージし、成功時は 24 h キャッシュへ保存する', async () => {
    const storage = new MemStorage();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const code = (JSON.parse(String(init?.body)) as { variables: { code: string } }).variables.code;
      calls.push(code);
      if (code === '23100') return gqlResponse('23100', '名古屋市', [{ id: 'd', year: 2022, registerationYear: 2024, wardCode: '23111', ward: { code: '23111', name: '港区' }, items: [item(1, true, 'https://x/minato-l1-new/tileset.json')] }]);
      return gqlResponse('39201', '高知市', [{ id: 'd', year: 2023, registerationYear: 2024, wardCode: null, ward: null, items: [item(1, true, 'https://x/kochi-l1-2023/tileset.json')] }]);
    }) as unknown as typeof fetch;
    let t = 1_000_000;
    const r = await refreshRegistry(base, { fetchImpl, storage, now: () => t });
    expect(r.source).toBe('catalog');
    expect(calls.sort()).toEqual(['23100', '39201']);
    expect(r.changed).toBe(1);
    expect(r.registry.tilesets[0].url).toBe('https://x/minato-l1-new/tileset.json');
    expect(storage.getItem(CATALOG_CACHE_KEY)).toContain('https://x/minato-l1-new/tileset.json');

    // 2 回目はキャッシュ（fetch 不要）
    const r2 = await refreshRegistry(base, { fetchImpl, storage, now: () => t + 1000 });
    expect(r2.source).toBe('cache');
    expect(calls).toHaveLength(2);
    // 24 h 経過で再取得
    t += 25 * 3600 * 1000;
    const r3 = await refreshRegistry(base, { fetchImpl, storage, now: () => t });
    expect(r3.source).toBe('catalog');
    expect(calls).toHaveLength(4);
  });

  it('タイムアウト・失敗した都市は静的値を維持し errors に残す（例外にしない）', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const code = (JSON.parse(String(init?.body)) as { variables: { code: string } }).variables.code;
      if (code === '23100') return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      return new Response('oops', { status: 500 });
    }) as unknown as typeof fetch;
    const r = await refreshRegistry(base, { fetchImpl, storage: null, timeoutMs: 10 });
    expect(r.source).toBe('static');
    expect(r.registry).toBe(base);
    expect(r.errors['23100']).toBe('timeout 10 ms');
    expect(r.errors['39201']).toBe('HTTP 500');
  });
});

describe('tilesets.ts', () => {
  it('フィクスチャは 6 都市・bbox 付きで正規化されている', () => {
    const cities = new Set(FIXTURE_REGISTRY.tilesets.map((e) => e.city_code));
    expect(cities.size).toBe(6);
    expect(FIXTURE_REGISTRY.tilesets.every((e) => e.bbox && (e.lod === 1 || e.lod === 2))).toBe(true);
  });
  it('normalizeRegistry は不正項目を落とし、lod/year を数値化する', () => {
    const r = normalizeRegistry({ tilesets: [{ city_code: '1', url: 'u', lod: '2', year: '2020', bbox: [1, 2, 3, 4] }, { city_code: '2' }, { city_code: '3', url: 'u', lod: 3, year: 2020 }] });
    expect(r.tilesets).toHaveLength(1);
    expect(r.tilesets[0]).toMatchObject({ lod: 2, year: 2020, bbox: [1, 2, 3, 4], texture: false, ward_code: null });
  });
  it('静的 JSON 取得失敗時はフィクスチャへフォールバックする', async () => {
    const bad = (async () => new Response('nf', { status: 404 })) as unknown as typeof fetch;
    const r = await loadRegistryDetailed({ fetchImpl: bad, url: 'x' });
    expect(r.source).toBe('fixture');
    expect(r.registry).toBe(FIXTURE_REGISTRY);
    const good = (async () => new Response(JSON.stringify({ generated: 'g', source: 's', tilesets: [NAGOYA_MINATO_L1] }))) as unknown as typeof fetch;
    const r2 = await loadRegistryDetailed({ fetchImpl: good, url: 'x' });
    expect(r2.source).toBe('static');
    expect(r2.registry.tilesets[0].url).toBe('u/minato-l1');
  });
});
