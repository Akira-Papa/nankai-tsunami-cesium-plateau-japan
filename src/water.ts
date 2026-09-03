/**
 * 津波水面（市区町村ポリゴン単位）
 *
 * - `municipalities_coastal.geojson` の Polygon / MultiPolygon を `PolygonHierarchy` に変換し、
 *   市区町村ごとに楕円体高 = H(muni) + ジオイド高(重心) の半透明水面を置く。
 * - H(muni): 選択中プリセット（`tsunami_h.json`）。値が無い市区町村は手動スライダー値へフォールバック。
 *   選択中の市区町村は常に UI の高さ（スライダー）を使う。
 * - 表示範囲（`camera.computeViewRectangle`＋マージン）と bbox が交差するものだけ生成し、それ以外は破棄。上限 ~40 エンティティ。
 * - 高さは `CallbackProperty` で毎フレーム参照するため、スライダー操作が滑らか。
 *
 * 注: 既定 granularity(1°) だと大きなポリゴンが数頂点の平面弦となり、中央が地球曲率で地形に沈むため 0.01° で細分化する。
 */
import * as Cesium from 'cesium';
import {
  bboxIntersects, findTsunamiRow, geometryBBox, tsunamiHeight,
  type BBox, type MunicipalitiesGeoJSON, type MunicipalityFeature, type Position, type TsunamiFile, type TsunamiPreset,
} from './data';

export interface WaterState {
  /** 選択中の市区町村（null なら全てプリセット値） */
  muniCode: string | null;
  /** UI の津波高（T.P. m）。選択中の市区町村とプリセット値が無い市区町村に適用 */
  heightM: number;
  preset: TsunamiPreset | 'case' | 'manual';
  /** preset が 'case' のときの内閣府 津波ケース "1".."11"（cases_2025 のキー） */
  caseId?: string | null;
  show: boolean;
}

export interface WaterOptions {
  /** 起動時に既に持っているポリゴン（空でよい。県別は `loadPref` で遅延取得） */
  geojson: MunicipalitiesGeoJSON;
  tsunami: TsunamiFile;
  /** 都道府県ごとの範囲（表示範囲と交差した県のポリゴンだけを読む） */
  prefBBoxes?: Record<string, BBox>;
  /** 県別ポリゴンの遅延取得（null = 取得失敗） */
  loadPref?: (prefCode: string) => Promise<MunicipalitiesGeoJSON | null>;
  geoidFn: (lon: number, lat: number) => number;
  /** 同時に存在させるエンティティ上限（既定 40） */
  maxEntities?: number;
  /** 表示範囲判定のマージン（度、既定 0.15 ≈ 15 km） */
  marginDeg?: number;
  onStatus?(text: string): void;
}

export interface WaterLayer {
  /** カメラ moveEnd などで呼ぶ。表示範囲に応じてポリゴンを生成／破棄 */
  refresh(force?: boolean): void;
  setState(p: Partial<WaterState>): void;
  getState(): WaterState;
  /** 市区町村の T.P. 津波高（選択・プリセット・フォールバック適用後） */
  tpHeightFor(code: string): number;
  /** 市区町村の楕円体高（T.P.＋ジオイド(重心)）。不明コードは null */
  ellipsoidHeightFor(code: string): number | null;
  /** 現在表示中の市区町村コード一覧 */
  visibleCodes(): string[];
  count(): number;
  dispose(): void;
}

interface PolyPart {
  hierarchy: Cesium.PolygonHierarchy;
  bbox: BBox;
  /** 頂点平均（ジオイド参照点） */
  centroid: { lon: number; lat: number };
}

interface MuniShape {
  code: string;
  name: string;
  bbox: BBox;
  parts: PolyPart[];
}

const WATER_COLOR = Cesium.Color.fromCssColorString('#1f8aa8').withAlpha(0.55);
const WATER_COLOR_SELECTED = Cesium.Color.fromCssColorString('#2aa0c4').withAlpha(0.6);
const GRANULARITY = Cesium.Math.toRadians(0.01);
/** 1 ポリゴンあたりの頂点上限（超える場合は間引く。契約の 50 m 簡略化なら通常は超えない） */
const MAX_RING_VERTICES = 6000;

function ringToPositions(ring: Position[]): Cesium.Cartesian3[] {
  // 閉環の末尾重複は Cesium 側で問題ないが、同一点連続は除去しておく。非数の座標は捨てる
  const step = ring.length > MAX_RING_VERTICES ? Math.ceil(ring.length / MAX_RING_VERTICES) : 1;
  const out: Cesium.Cartesian3[] = [];
  let prev: Position | undefined;
  for (let i = 0; i < ring.length; i += step) {
    const p = ring[i];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    out.push(Cesium.Cartesian3.fromDegrees(p[0], p[1], 0));
    prev = p;
  }
  // 閉環で先頭と末尾が同一なら末尾を落とし、実質 3 点未満（退化形状）は無効
  if (out.length >= 2 && Cesium.Cartesian3.equals(out[0], out[out.length - 1])) out.pop();
  return out.length >= 3 ? out : [];
}

function polygonToPart(rings: Position[][]): PolyPart | null {
  if (!rings.length || rings[0].length < 4) return null;
  const outer = ringToPositions(rings[0]);
  if (outer.length < 3) return null;
  const c0 = polygonToPartCentroid(rings[0]);
  if (!c0) return null;
  // 面積ゼロ（共線・潰れた小島）の環は除外。Cesium の PolygonGeometryUpdater は靴紐公式の重心を
  // TerrainOffsetProperty に使うため、面積 0 だと NaN になり「Rendering has stopped」で描画が止まる
  const holes = rings.slice(1)
    .filter((r) => ringArea(r) > MIN_RING_AREA)
    .map((r) => new Cesium.PolygonHierarchy(ringToPositions(r)))
    .filter((h) => h.positions.length >= 3);
  return { hierarchy: new Cesium.PolygonHierarchy(outer, holes), bbox: c0.bbox, centroid: c0.centroid };
}

/** 平面近似の面積（度²・絶対値）。退化形状の判定用 */
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return 0;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}
/** 4 桁丸め（約 11 m）の座標で 3 点が潰れると面積は 1e-8 度² 未満になる。安全側に 1e-9 を下限とする */
const MIN_RING_AREA = 1e-9;

function polygonToPartCentroid(ring: Position[]): { bbox: BBox; centroid: { lon: number; lat: number } } | null {
  if (ringArea(ring) <= MIN_RING_AREA) return null;
  let sx = 0, sy = 0, n = 0;
  let w = Infinity, s = Infinity, e = -Infinity, no = -Infinity;
  for (const p of ring) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    sx += p[0]; sy += p[1]; n++;
    if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1]; if (p[1] > no) no = p[1];
  }
  if (n === 0 || !(e > w) || !(no > s)) return null; // 幅または高さが 0 の退化形状
  return { bbox: [w, s, e, no], centroid: { lon: sx / n, lat: sy / n } };
}

function featureToShape(f: MunicipalityFeature): MuniShape | null {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const parts = polys.map(polygonToPart).filter((p): p is PolyPart => p !== null);
  if (!parts.length) return null;
  return { code: f.properties.code, name: f.properties.name, bbox: f.bbox ?? geometryBBox(g), parts };
}

export function createWaterLayer(viewer: Cesium.Viewer, opts: WaterOptions): WaterLayer {
  const maxEntities = opts.maxEntities ?? 40;
  const margin = opts.marginDeg ?? 0.15;
  const shapes: MuniShape[] = [];
  const byCode = new Map<string, MuniShape>();
  function addFeatures(fc: MunicipalitiesGeoJSON) {
    for (const f of fc.features) {
      if (byCode.has(f.properties.code)) continue;
      const s = featureToShape(f);
      if (s) { shapes.push(s); byCode.set(s.code, s); }
      else console.warn('[水面] ジオメトリを変換できません:', f.properties?.code, f.properties?.name);
    }
  }
  addFeatures(opts.geojson);
  /** 県別ポリゴンの読込状態（'loading' | 'done' | 'failed'） */
  const prefState = new Map<string, 'loading' | 'done' | 'failed'>();
  function ensurePrefs(view: BBox) {
    if (!opts.prefBBoxes || !opts.loadPref) return;
    for (const [pref, bb] of Object.entries(opts.prefBBoxes)) {
      if (prefState.has(pref) || !bboxIntersects(bb, view, margin)) continue;
      prefState.set(pref, 'loading');
      opts.onStatus?.(`水面: 県別ポリゴン読込中（${pref}）`);
      void opts.loadPref(pref).then((fc) => {
        if (!fc) { prefState.set(pref, 'failed'); return; }
        prefState.set(pref, 'done');
        addFeatures(fc);
        refresh(true);
      });
    }
  }

  const state: WaterState = { muniCode: null, heightM: 3.0, preset: 'max_2025', show: true };
  const ds = new Cesium.CustomDataSource('津波水面');
  void viewer.dataSources.add(ds);

  /** 生成済みエンティティ（コード → エンティティ配列） */
  const live = new Map<string, Cesium.Entity[]>();
  /** 高さキャッシュ（CallbackProperty から毎フレーム参照するため軽量に） */
  const heightCache = new Map<string, number>();

  function tpHeightFor(code: string): number {
    if (code === state.muniCode || state.preset === 'manual') return state.heightM;
    const row = findTsunamiRow(opts.tsunami, code);
    if (state.preset === 'case') {
      // ケース別: その市区町村のそのケースの公表値。無ければ 2025 最大 → UI 値の順で代替
      const v = state.caseId ? row?.cases_2025?.[state.caseId] : null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      return tsunamiHeight(row, 'max_2025') ?? state.heightM;
    }
    const h = tsunamiHeight(row, state.preset);
    return h ?? state.heightM;
  }

  function recomputeHeights() {
    heightCache.clear();
    for (const [code, ents] of live) {
      const shape = byCode.get(code);
      if (!shape) continue;
      const tp = tpHeightFor(code);
      ents.forEach((ent, i) => {
        const part = shape.parts[i];
        const key = `${code}#${i}`;
        heightCache.set(key, tp + opts.geoidFn(part.centroid.lon, part.centroid.lat));
        const poly = ent.polygon;
        if (poly) {
          // 高さは定数プロパティ（CallbackProperty だと毎フレーム形状を再生成し操作が重くなる）
          const h = heightCache.get(key) ?? 0;
          const cur = poly.height?.getValue(Cesium.JulianDate.now()) as number | undefined;
          if (cur !== h) poly.height = new Cesium.ConstantProperty(h);
          poly.material = new Cesium.ColorMaterialProperty(code === state.muniCode ? WATER_COLOR_SELECTED : WATER_COLOR);
        }
      });
    }
    viewer.scene.requestRender();
  }

  function ellipsoidHeightFor(code: string): number | null {
    const shape = byCode.get(code);
    if (!shape) return null;
    const p = shape.parts[0];
    return tpHeightFor(code) + opts.geoidFn(p.centroid.lon, p.centroid.lat);
  }

  function createEntities(shape: MuniShape) {
    const ents = shape.parts.map((part, i) => {
      const key = `${shape.code}#${i}`;
      return ds.entities.add({
        id: `water:${key}`,
        name: `津波水面 ${shape.name}`,
        show: state.show,
        polygon: {
          hierarchy: part.hierarchy,
          height: new Cesium.ConstantProperty(heightCache.get(key) ?? (tpHeightFor(shape.code) + opts.geoidFn(part.centroid.lon, part.centroid.lat))),
          heightReference: Cesium.HeightReference.NONE,
          granularity: GRANULARITY,
          material: shape.code === state.muniCode ? WATER_COLOR_SELECTED : WATER_COLOR,
          outline: false,
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
    });
    live.set(shape.code, ents);
  }

  function destroyEntities(code: string) {
    const ents = live.get(code);
    if (!ents) return;
    for (const e of ents) ds.entities.remove(e);
    live.delete(code);
  }

  let lastRect: Cesium.Rectangle | undefined;
  const scratchRect = new Cesium.Rectangle();

  function currentViewBBox(): BBox | undefined {
    const r = viewer.camera.computeViewRectangle(Cesium.Ellipsoid.WGS84, scratchRect);
    if (r) lastRect = Cesium.Rectangle.clone(r, lastRect);
    const use = r ?? lastRect;
    if (!use) return undefined;
    return [Cesium.Math.toDegrees(use.west), Cesium.Math.toDegrees(use.south), Cesium.Math.toDegrees(use.east), Cesium.Math.toDegrees(use.north)];
  }

  /** これより広い視野（度）では水面を出さない（全国俯瞰で全県ポリゴンを読み込まないため） */
  const MAX_VIEW_SPAN_DEG = 5;

  function refresh(force = false) {
    const view = currentViewBBox();
    if (!view) return;
    if (view[2] - view[0] > MAX_VIEW_SPAN_DEG || view[3] - view[1] > MAX_VIEW_SPAN_DEG) {
      for (const code of [...live.keys()]) destroyEntities(code);
      opts.onStatus?.('水面: 広域のため非表示（ズームすると表示）');
      return;
    }
    ensurePrefs(view);
    const cx = (view[0] + view[2]) / 2, cy = (view[1] + view[3]) / 2;
    // 表示範囲と交差する市区町村を、視点中心に近い順に並べて上限まで採用（選択中は常に優先）
    const candidates = shapes
      .filter((s) => bboxIntersects(s.bbox, view, margin))
      .map((s) => ({ s, d: s.code === state.muniCode ? -1 : Math.hypot((s.bbox[0] + s.bbox[2]) / 2 - cx, (s.bbox[1] + s.bbox[3]) / 2 - cy) }))
      .sort((a, b) => a.d - b.d);
    const wanted: MuniShape[] = [];
    let budget = maxEntities;
    for (const { s } of candidates) {
      if (s.parts.length > budget && wanted.length > 0) continue;
      wanted.push(s);
      budget -= s.parts.length;
      if (budget <= 0) break;
    }
    const wantedCodes = new Set(wanted.map((s) => s.code));
    let changed = force;
    for (const code of [...live.keys()]) {
      if (!wantedCodes.has(code)) { destroyEntities(code); changed = true; }
    }
    for (const s of wanted) {
      if (!live.has(s.code)) { createEntities(s); changed = true; }
    }
    if (changed) recomputeHeights();
    opts.onStatus?.(`水面: ${live.size} 市区町村（${count()} 面）`);
  }

  function count() {
    let n = 0;
    for (const e of live.values()) n += e.length;
    return n;
  }

  function setState(p: Partial<WaterState>) {
    const prevShow = state.show;
    const prevMuni = state.muniCode;
    Object.assign(state, p);
    if (state.show !== prevShow) {
      for (const ents of live.values()) for (const e of ents) e.show = state.show;
    }
    if (state.muniCode !== prevMuni) refresh(true);
    else recomputeHeights();
  }

  return {
    refresh,
    setState,
    getState: () => ({ ...state }),
    tpHeightFor,
    ellipsoidHeightFor,
    visibleCodes: () => [...live.keys()],
    count,
    dispose() {
      for (const code of [...live.keys()]) destroyEntities(code);
      viewer.dataSources.remove(ds, true);
    },
  };
}
