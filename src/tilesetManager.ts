/**
 * PLATEAU 建築物 3D Tiles の視野連動ローダ（全国版）
 *
 * - `update()`（camera.moveEnd で呼ぶ）ごとに視野矩形を求め、20 % 広げた矩形と `bbox` が交差する
 *   レジストリ項目（市区ごとに最新 `year`、`lod2` フラグに応じた LOD、LOD2 が無ければ LOD1）だけを読み込む。
 * - 同時読込は `maxConcurrent` 本まで（キュー）。視野から外れた tileset は非表示にして小さな LRU（≤ 6）へ
 *   退避し、LRU から溢れたものを `scene.primitives.remove` で破棄する。
 * - 表示上限: デスクトップ 8 / モバイル 3（`navigator.maxTouchPoints > 0`）。上限超過時は視野中心に近い順。
 * - カメラ高度 60 km 超では建物を出さない（「建物: 広域のため非表示」）。
 * - 水没着色: 名古屋版 `main.ts` の CustomShader（positionEC + czm_inverseViewRotation + u_camToOrigin）を
 *   tileset ごとに 1 個ずつ生成し、ENU 原点を各 tileset の bbox 中心に置く。水面の楕円体高は
 *   `geoidFn(bbox中心) + tpHeight` で tileset ごとに計算する（都市ごとにジオイド高が違うため）。
 *
 * 純粋ロジック（矩形交差・選択・LRU）は `createTilesetManager` から分離して export し、vitest（node）で検証する。
 */
import * as Cesium from 'cesium';

// ---------------------------------------------------------------------------
// 型（`./data` と同形。A1 側の `PlateauRegistry` と構造的に互換）
// ---------------------------------------------------------------------------
export interface PlateauTilesetEntry {
  city_code: string;
  city: string;
  pref_code: string;
  pref: string;
  ward_code: string | null;
  ward: string | null;
  lod: 1 | 2;
  texture: boolean;
  year: number;
  url: string;
  /** [west, south, east, north]（度）。取得失敗時は null */
  bbox: [number, number, number, number] | null;
  http_status?: number;
}
export interface PlateauRegistry {
  generated: string;
  source: string;
  tilesets: PlateauTilesetEntry[];
}

export interface TilesetManagerOptions {
  registry: PlateauRegistry;
  maxConcurrent: number;
  lod2: boolean;
  onStatus?(text: string): void;
  // ---- 以下は任意（既定値あり。主にテスト・チューニング用） ----
  /** 同時表示上限。既定: デスクトップ 8 / モバイル 3 */
  maxLoaded?: number;
  /** LRU に退避しておく非表示 tileset の上限。既定: デスクトップ 6 / モバイル 1 */
  lruSize?: number;
  /** モバイル判定の上書き。既定: `navigator.maxTouchPoints > 0` */
  mobile?: boolean;
  /** 建物を出さないカメラ高度（m）。既定 60 000 */
  maxCameraHeight?: number;
  /** 視野矩形の拡張率。既定 0.2（20 %） */
  expandRatio?: number;
  /** Legacy uniform water shader. Disable for computed inundation data. */
  inundationShading?: boolean;
}

export interface TilesetManager {
  /** camera.moveEnd で呼ぶ */
  update(): void;
  setEnabled(on: boolean): void;
  setLod2(on: boolean): void;
  setWaterLevel(ellipsoidHeightAtCenter: number, geoidFn: (lon: number, lat: number) => number, tpHeight: number): void;
  dispose(): void;
  stats(): { loaded: number; loading: number };
}

/** [west, south, east, north]（度） */
export type Bbox = [number, number, number, number];

// ---------------------------------------------------------------------------
// 純粋ロジック
// ---------------------------------------------------------------------------
export function rectIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** 矩形を各辺方向へ `ratio` 分だけ広げる（20 % → 幅・高さがそれぞれ 1.4 倍） */
export function expandRect(r: Bbox, ratio: number): Bbox {
  const dw = (r[2] - r[0]) * ratio;
  const dh = (r[3] - r[1]) * ratio;
  return [r[0] - dw, r[1] - dh, r[2] + dw, r[3] + dh];
}

export function bboxCenter(b: Bbox): { lon: number; lat: number } {
  return { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 };
}

/** 選択単位のキー（区があれば区、なければ市） */
export function groupKey(e: Pick<PlateauTilesetEntry, 'city_code' | 'ward_code'>): string {
  return e.ward_code ?? e.city_code;
}

/** 読込対象になり得る項目か（URL・bbox があり、疎通確認済みなら 200 のもの） */
export function isUsable(e: PlateauTilesetEntry): boolean {
  if (!e.url || !e.bbox || e.bbox.some((v) => !Number.isFinite(v))) return false;
  if (e.http_status !== undefined && e.http_status !== 200) return false;
  return true;
}

/**
 * 市区ごとに 1 件を選ぶ: 最新 `year` → 希望 LOD（`lod2` なら 2、無ければ 1 へフォールバック）→ テクスチャなし優先。
 * `view` を渡すと拡張済み視野矩形と交差する市区だけを返す。
 */
export function selectEntries(entries: readonly PlateauTilesetEntry[], lod2: boolean, view?: Bbox): PlateauTilesetEntry[] {
  const groups = new Map<string, PlateauTilesetEntry[]>();
  for (const e of entries) {
    if (!isUsable(e)) continue;
    if (view && !rectIntersects(view, e.bbox!)) continue;
    const k = groupKey(e);
    const g = groups.get(k);
    if (g) g.push(e); else groups.set(k, [e]);
  }
  const out: PlateauTilesetEntry[] = [];
  for (const g of groups.values()) {
    const latest = Math.max(...g.map((e) => e.year));
    const inYear = g.filter((e) => e.year === latest);
    const want = lod2 ? 2 : 1;
    const pool = inYear.some((e) => e.lod === want) ? inYear.filter((e) => e.lod === want) : inYear;
    // LOD2 希望で LOD2 が無い → LOD1。LOD1 希望で LOD1 が無い → LOD2（唯一の選択肢）
    pool.sort((a, b) => Number(a.texture) - Number(b.texture) || Math.abs(a.lod - want) - Math.abs(b.lod - want));
    out.push(pool[0]);
  }
  return out;
}

/** 視野中心からの距離（度ベースの近似）で近い順に並べ、`limit` 件へ切り詰める */
export function prioritize(entries: readonly PlateauTilesetEntry[], center: { lon: number; lat: number }, limit: number): PlateauTilesetEntry[] {
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const d2 = (e: PlateauTilesetEntry) => {
    const c = bboxCenter(e.bbox!);
    const dx = (c.lon - center.lon) * cosLat;
    const dy = c.lat - center.lat;
    return dx * dx + dy * dy;
  };
  return [...entries].sort((a, b) => d2(a) - d2(b)).slice(0, Math.max(0, limit));
}

/** 直近使用順を保つ小さな LRU。溢れた要素は `onEvict` で通知 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(readonly capacity: number, private readonly onEvict: (key: K, value: V) => void) {}
  get size() { return this.map.size; }
  has(k: K) { return this.map.has(k); }
  /** 取り出して LRU から外す */
  take(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) this.map.delete(k);
    return v;
  }
  put(k: K, v: V) {
    if (this.capacity <= 0) { this.onEvict(k, v); return; }
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      const ov = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.onEvict(oldest, ov);
    }
  }
  clear() {
    for (const [k, v] of this.map) this.onEvict(k, v);
    this.map.clear();
  }
  keys() { return [...this.map.keys()]; }
}

// ---------------------------------------------------------------------------
// Cesium 依存部
// ---------------------------------------------------------------------------
/** テストで差し替えられる最小の Viewer 形状 */
interface ViewerLike {
  camera: {
    computeViewRectangle(): { west: number; south: number; east: number; north: number } | undefined;
    positionCartographic: { longitude: number; latitude: number; height: number };
    positionWC: Cesium.Cartesian3;
  };
  scene: {
    primitives: { add(p: unknown): unknown; remove(p: unknown): boolean };
    preRender: { addEventListener(fn: () => void): unknown; removeEventListener(fn: () => void): boolean };
    requestRender(): void;
  };
}

interface Slot {
  entry: PlateauTilesetEntry;
  tileset: Cesium.Cesium3DTileset;
  shader: Cesium.CustomShader;
  origin: Cesium.Cartesian3;
  scratch: Cesium.Cartesian3;
}

const RAD2DEG = 180 / Math.PI;
const DEFAULT_MAX_CAMERA_HEIGHT = 60_000;
const MB = 1024 * 1024;

const SHADER_SRC = /* glsl */ `
  void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    // p − o = (p − cam) − (o − cam)。EC ベクトルを世界向きへ回転（czm_inverseViewRotation）
    vec3 d = czm_inverseViewRotation * fsInput.attributes.positionEC - u_camToOrigin;
    float R = 6371000.0;
    float h = dot(d, u_up) + dot(d, d) / (2.0 * R);
    vec3 base = vec3(0.86, 0.87, 0.85);
    vec3 wet  = vec3(0.10, 0.35, 0.55);
    float depth = u_waterHeight - h;
    float t = clamp(depth / 2.0, 0.0, 1.0); // 水面下 2 m で完全に青
    material.diffuse = mix(base, wet, t * 0.85);
    material.roughness = 0.9;
  }
`;

function detectMobile(): boolean {
  try {
    return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

export function createTilesetManager(viewer: Cesium.Viewer, opts: TilesetManagerOptions): TilesetManager {
  const v = viewer as unknown as ViewerLike;
  const mobile = opts.mobile ?? detectMobile();
  const maxLoaded = opts.maxLoaded ?? (mobile ? 3 : 8);
  const lruSize = opts.lruSize ?? (mobile ? 1 : 6);
  const maxConcurrent = Math.max(1, opts.maxConcurrent | 0);
  const maxCameraHeight = opts.maxCameraHeight ?? DEFAULT_MAX_CAMERA_HEIGHT;
  const expandRatio = opts.expandRatio ?? 0.2;
  const tilesetOptions: Cesium.Cesium3DTileset.ConstructorOptions = mobile
    ? { maximumScreenSpaceError: 24, cacheBytes: 48 * MB, maximumCacheOverflowBytes: 16 * MB, skipLevelOfDetail: true, dynamicScreenSpaceError: true }
    : { maximumScreenSpaceError: 16, cacheBytes: 96 * MB, maximumCacheOverflowBytes: 32 * MB, skipLevelOfDetail: true, dynamicScreenSpaceError: true };

  let lod2 = opts.lod2;
  let enabled = true;
  let disposed = false;
  let lastStatus = '';

  /** 水位パラメータ（tileset ごとの水面高を再計算するために保持） */
  let water: { fallback: number; geoidFn?: (lon: number, lat: number) => number; tp: number } = { fallback: 0, tp: 0 };

  const active = new Map<string, Slot>();      // url → 表示中
  const loading = new Map<string, PlateauTilesetEntry>(); // url → 読込中
  const queue: PlateauTilesetEntry[] = [];     // 読込待ち
  const failed = new Map<string, string>();    // url → 失敗理由
  let desired = new Map<string, PlateauTilesetEntry>(); // url → 現在の視野で必要
  const lru = new Lru<string, Slot>(lruSize, (_k, slot) => destroySlot(slot));

  const requestRender = () => { try { v.scene.requestRender(); } catch { /* noop */ } };

  function waterHeightFor(entry: PlateauTilesetEntry): number {
    if (water.geoidFn && entry.bbox) {
      try {
        const c = bboxCenter(entry.bbox);
        const g = water.geoidFn(c.lon, c.lat);
        if (Number.isFinite(g)) return g + water.tp;
      } catch (e) {
        console.warn('[建物] geoidFn が失敗。中心値で代用:', e);
      }
    }
    return water.fallback;
  }

  function makeShader(entry: PlateauTilesetEntry, origin: Cesium.Cartesian3, scratch: Cesium.Cartesian3): Cesium.CustomShader {
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cesium.Cartesian3());
    return new Cesium.CustomShader({
      mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
      lightingModel: Cesium.LightingModel.PBR,
      uniforms: {
        u_waterHeight: { type: Cesium.UniformType.FLOAT, value: waterHeightFor(entry) },
        u_camToOrigin: { type: Cesium.UniformType.VEC3, value: Cesium.Cartesian3.subtract(origin, v.camera.positionWC, scratch) },
        u_up: { type: Cesium.UniformType.VEC3, value: up },
      },
      fragmentShaderText: SHADER_SRC,
    });
  }

  /** 毎フレーム: 各 tileset の u_camToOrigin を double で再計算（float32 精度対策。名古屋版と同じ） */
  const onPreRender = () => {
    for (const s of active.values()) {
      Cesium.Cartesian3.subtract(s.origin, v.camera.positionWC, s.scratch);
      s.shader.setUniform('u_camToOrigin', s.scratch);
    }
  };
  v.scene.preRender.addEventListener(onPreRender);

  function destroySlot(slot: Slot) {
    try {
      slot.tileset.loadProgress.removeEventListener(requestRender);
      slot.tileset.allTilesLoaded.removeEventListener(requestRender);
    } catch { /* noop */ }
    try {
      // destroyPrimitives=true（既定）のため remove で destroy される。未登録なら明示 destroy
      const removed = v.scene.primitives.remove(slot.tileset);
      if (!removed && !slot.tileset.isDestroyed()) slot.tileset.destroy();
    } catch (e) {
      console.warn('[建物] tileset の破棄に失敗:', e);
    }
  }

  function label(e: PlateauTilesetEntry) {
    return `${e.city}${e.ward ? ' ' + e.ward : ''} LOD${e.lod}${e.texture ? '' : '(notex)'} ${e.year}`;
  }

  /** 視野矩形（度）。computeViewRectangle が取れない場合はカメラ位置と高度から近似 */
  function viewRect(): { rect: Bbox; center: { lon: number; lat: number }; height: number } | undefined {
    let carto: ViewerLike['camera']['positionCartographic'];
    try { carto = v.camera.positionCartographic; } catch { return undefined; }
    if (!carto || !Number.isFinite(carto.height)) return undefined;
    const lon = carto.longitude * RAD2DEG;
    const lat = carto.latitude * RAD2DEG;
    const height = carto.height;
    let rect: Bbox | undefined;
    try {
      const r = v.camera.computeViewRectangle();
      if (r && [r.west, r.south, r.east, r.north].every(Number.isFinite)) {
        rect = [r.west * RAD2DEG, r.south * RAD2DEG, r.east * RAD2DEG, r.north * RAD2DEG];
        // 地平線を含む見下ろし角では矩形が極端に広がるため、カメラ直下を中心とした高度比例の枠で切り詰める
        const cap = Math.max(0.05, (height * 4) / 111_000);
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        const clamp: Bbox = [lon - cap / cosLat, lat - cap, lon + cap / cosLat, lat + cap];
        if (rect[2] < rect[0]) rect = undefined; // 日付変更線跨ぎ等の異常値
        else if (!rectIntersects(rect, clamp)) rect = undefined;
        else rect = [Math.max(rect[0], clamp[0]), Math.max(rect[1], clamp[1]), Math.min(rect[2], clamp[2]), Math.min(rect[3], clamp[3])];
      }
    } catch { rect = undefined; }
    if (!rect) {
      const rDeg = Math.max(0.02, (height * 1.5) / 111_000);
      const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      rect = [lon - rDeg / cosLat, lat - rDeg, lon + rDeg / cosLat, lat + rDeg];
    }
    return { rect, center: bboxCenter(rect), height };
  }

  function emitStatus(text: string) {
    if (text === lastStatus) return;
    lastStatus = text;
    try { opts.onStatus?.(text); } catch (e) { console.warn('[建物] onStatus で例外:', e); }
  }

  function reportStatus(extra?: string) {
    if (disposed) return;
    if (extra) { emitStatus(extra); return; }
    if (!enabled) { emitStatus('建物: 非表示'); return; }
    const cities = new Set([...active.values()].map((s) => s.entry.city_code));
    const loadingCount = loading.size + queue.length;
    const failedInView = [...desired.keys()].filter((u) => failed.has(u)).length;
    let text = `建物: ${cities.size}都市 表示`;
    if (loadingCount > 0) text += `（読込中 ${loadingCount}）`;
    if (failedInView > 0) text += `／${failedInView}件 失敗`;
    emitStatus(text);
  }

  /** 表示中／LRU／キュー／読込中を `desired` に合わせる */
  function reconcile() {
    // 1) 必要なものを先に LRU から復帰（後の退避で evict されないよう順序が重要）、無ければキューへ
    queue.length = 0;
    for (const [url, entry] of desired) {
      if (active.has(url) || loading.has(url) || failed.has(url)) continue;
      const slot = lru.take(url);
      if (slot) {
        slot.tileset.show = true;
        slot.shader.setUniform('u_waterHeight', waterHeightFor(entry));
        active.set(url, slot);
      } else {
        queue.push(entry);
      }
    }
    // 2) 不要になった表示中 tileset を LRU へ退避（溢れた分は destroy）
    for (const [url, slot] of [...active]) {
      if (desired.has(url)) continue;
      active.delete(url);
      slot.tileset.show = false;
      lru.put(url, slot);
    }
    pump();
    requestRender();
    reportStatus();
  }

  function pump() {
    while (!disposed && enabled && loading.size < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!;
      if (!desired.has(entry.url) || active.has(entry.url) || loading.has(entry.url)) continue;
      loading.set(entry.url, entry);
      void load(entry);
    }
  }

  async function load(entry: PlateauTilesetEntry) {
    let ts: Cesium.Cesium3DTileset | undefined;
    try {
      ts = await Cesium.Cesium3DTileset.fromUrl(entry.url, tilesetOptions);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.set(entry.url, msg);
      console.warn(`[建物] ${label(entry)} の読込に失敗:`, msg);
      loading.delete(entry.url);
      if (!disposed) { pump(); reportStatus(); }
      return;
    }
    loading.delete(entry.url);
    if (disposed) { try { ts.destroy(); } catch { /* noop */ } return; }
    const c = bboxCenter(entry.bbox!);
    const origin = Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 0);
    const scratch = new Cesium.Cartesian3();
    const slot: Slot = { entry, tileset: ts, shader: makeShader(entry, origin, scratch), origin, scratch };
    try {
      if (opts.inundationShading !== false) ts.customShader = slot.shader;
      ts.loadProgress.addEventListener(requestRender);
      ts.allTilesLoaded.addEventListener(requestRender);
      v.scene.primitives.add(ts);
    } catch (e) {
      console.warn(`[建物] ${label(entry)} の登録に失敗:`, e);
      failed.set(entry.url, e instanceof Error ? e.message : String(e));
      try { if (!ts.isDestroyed()) ts.destroy(); } catch { /* noop */ }
      pump(); reportStatus();
      return;
    }
    if (desired.has(entry.url) && enabled) {
      ts.show = true;
      active.set(entry.url, slot);
    } else {
      ts.show = false; // 読込中に視野から外れた → LRU へ
      lru.put(entry.url, slot);
    }
    pump();
    requestRender();
    reportStatus();
  }

  function update() {
    if (disposed) return;
    if (!enabled) { desired = new Map(); reconcile(); return; }
    const vr = viewRect();
    if (!vr) { desired = new Map(); reconcile(); return; }
    if (vr.height > maxCameraHeight) {
      desired = new Map();
      reconcile();
      reportStatus('建物: 広域のため非表示');
      return;
    }
    const view = expandRect(vr.rect, expandRatio);
    const picked = prioritize(selectEntries(opts.registry.tilesets, lod2, view), vr.center, maxLoaded);
    desired = new Map(picked.map((e) => [e.url, e]));
    reconcile();
  }

  return {
    update,
    setEnabled(on: boolean) {
      if (disposed || enabled === on) return;
      enabled = on;
      if (on) update();
      else { desired = new Map(); reconcile(); }
    },
    setLod2(on: boolean) {
      if (disposed || lod2 === on) return;
      lod2 = on;
      update();
    },
    setWaterLevel(ellipsoidHeightAtCenter: number, geoidFn: (lon: number, lat: number) => number, tpHeight: number) {
      water = { fallback: ellipsoidHeightAtCenter, geoidFn, tp: tpHeight };
      for (const s of active.values()) s.shader.setUniform('u_waterHeight', waterHeightFor(s.entry));
      for (const url of lru.keys()) {
        const s = lru.take(url)!;
        s.shader.setUniform('u_waterHeight', waterHeightFor(s.entry));
        lru.put(url, s);
      }
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { v.scene.preRender.removeEventListener(onPreRender); } catch { /* noop */ }
      queue.length = 0;
      desired = new Map();
      for (const s of active.values()) destroySlot(s);
      active.clear();
      lru.clear();
      loading.clear();
      requestRender();
    },
    stats() {
      return { loaded: active.size, loading: loading.size + queue.length };
    },
  };
}
