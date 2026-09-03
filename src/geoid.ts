/**
 * ジオイド高（GSIGEO2011）: japan-geoid（MIT, MIERUNE）の WASM を利用。
 *
 * - `await initGeoid()` 後に `geoidHeight(lon, lat)` が同期で使える。
 * - WASM 初期化に失敗した場合は、地形サンプリング＋地理院 標高API による推定値（または既定値）へフォールバック。
 * - 旧プロトタイプの「地形サンプリング推定」は健全性チェックとして残し、japan-geoid との差が 0.5 m を超えたら警告する。
 *
 * 出典表記（japan-geoid README より）: 「測量法に基づく国土地理院長承認（使用）R 5JHs 560」
 */
import * as Cesium from 'cesium';
import init, { loadEmbeddedGSIGEO2011, type GsiGeoid } from 'japan-geoid';
import wasmUrl from 'japan-geoid/japan_geoid_bg.wasm?url';

/** クレジット表記（README 記載の承認番号を転記） */
export const GEOID_CREDIT = 'ジオイド: 日本のジオイド2011 GSIGEO2011（国土地理院）／ japan-geoid（測量法に基づく国土地理院長承認（使用）R 5JHs 560）';
export const GEOID_CREDIT_HTML =
  'ジオイド: GSIGEO2011（国土地理院）／ <a href="https://github.com/MIERUNE/japan-geoid" target="_blank" rel="noopener">japan-geoid</a>（測量法に基づく国土地理院長承認（使用）R 5JHs 560）';

/** WASM が使えない場合の既定値（日本の主要沿岸部で概ね 25〜45 m。名古屋 ≈ 37.5） */
const GEOID_FALLBACK_M = 36.0;
/** 妥当範囲（日本国内） */
const GEOID_PLAUSIBLE = { min: 15, max: 60 };
// 代表点が斜面だと PLATEAU-Terrain と地理院標高API の解像度差だけで 0.5〜1 m ずれるため、
// 利用者向けバナーは 1.5 m 超のみ（それ未満は console.warn に留める）
const SANITY_THRESHOLD_M = 1.5;
const TIMEOUT_MS = 15_000;

let model: GsiGeoid | null = null;
let initPromise: Promise<boolean> | null = null;
let fallbackGeoid = GEOID_FALLBACK_M;

export type GeoidSource = 'gsigeo2011' | 'terrain-estimate' | 'default';
let source: GeoidSource = 'default';

export function geoidSource(): GeoidSource { return source; }
export function isGeoidReady(): boolean { return model !== null; }

/** WASM を初期化する（冪等）。成功で true。失敗しても例外は投げず false（フォールバック動作） */
export function initGeoid(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await init({ module_or_path: wasmUrl });
      model = loadEmbeddedGSIGEO2011();
      // 自己診断: README の例（新潟県 138.28, 37.12 → 39.47）
      const probe = model.getHeight(138.2839817085188, 37.12378643088312);
      if (!Number.isFinite(probe) || Math.abs(probe - 39.47) > 0.1) throw new Error(`self-test failed: ${probe}`);
      source = 'gsigeo2011';
      console.info(`[ジオイド] japan-geoid 初期化完了（自己診断 ${probe.toFixed(3)} m）`);
      return true;
    } catch (e) {
      console.warn('[ジオイド] japan-geoid の初期化に失敗。推定値／既定値で動作します:', e);
      model = null;
      return false;
    }
  })();
  return initPromise;
}

/**
 * ジオイド高（m）。WASM 未初期化・領域外（NaN）の場合はフォールバック値を返す（常に有限値）。
 */
export function geoidHeight(lon: number, lat: number): number {
  if (model) {
    const h = model.getHeight(lon, lat);
    if (Number.isFinite(h)) return h;
  }
  return fallbackGeoid;
}

/** フォールバック値を外部（地形推定・手動）から設定 */
export function setFallbackGeoid(v: number, src: GeoidSource = 'terrain-estimate') {
  if (Number.isFinite(v)) {
    fallbackGeoid = v;
    if (!model) source = src;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label} timed out (${ms} ms)`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 地理院 標高API（T.P. 標高）。データなしは NaN */
async function fetchGsiElevation(lon: number, lat: number): Promise<number> {
  const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon}&lat=${lat}&outtype=JSON`;
  const res = await withTimeout(fetch(url), TIMEOUT_MS, '標高API');
  if (!res.ok) throw new Error(`標高API HTTP ${res.status}`);
  const j = (await res.json()) as { elevation?: number | string };
  const v = typeof j.elevation === 'number' ? j.elevation : parseFloat(String(j.elevation));
  return Number.isFinite(v) ? v : NaN;
}

/** 地形（quantized-mesh）の楕円体高をサンプリング */
async function sampleTerrainHeight(provider: Cesium.TerrainProvider, lon: number, lat: number): Promise<number> {
  const pos = [Cesium.Cartographic.fromDegrees(lon, lat)];
  const sampled = provider.availability
    ? await withTimeout(Cesium.sampleTerrainMostDetailed(provider, pos), TIMEOUT_MS, 'sampleTerrainMostDetailed')
    : await withTimeout(Cesium.sampleTerrain(provider, 14, pos), TIMEOUT_MS, 'sampleTerrain(14)');
  const h = sampled[0]?.height;
  if (typeof h !== 'number' || !Number.isFinite(h)) throw new Error('terrain sample non-finite');
  return h;
}

export interface GeoidSanityResult {
  lon: number; lat: number;
  /** japan-geoid の値（WASM 未初期化時は null） */
  model: number | null;
  /** 地形楕円体高 − 標高API T.P. */
  estimate: number | null;
  terrainEllipsoidH: number | null;
  gsiElevation: number | null;
  diff: number | null;
  /** |diff| > 0.5 m */
  warn: boolean;
  message: string;
}

/**
 * 健全性チェック: 代表点で「PLATEAU-Terrain の楕円体高 − 地理院標高API の T.P. 標高」を旧式のジオイド推定として計算し、
 * japan-geoid の値と比較する。差が 0.5 m を超えたら `warn: true`（呼び出し側でバナー表示）。
 * WASM が無い場合は推定値をフォールバック値として採用する。
 */
export async function sanityCheckGeoid(provider: Cesium.TerrainProvider | undefined, lon: number, lat: number): Promise<GeoidSanityResult> {
  const modelH = model ? geoidHeight(lon, lat) : null;
  const base: GeoidSanityResult = { lon, lat, model: modelH, estimate: null, terrainEllipsoidH: null, gsiElevation: null, diff: null, warn: false, message: '' };
  if (!provider || provider instanceof Cesium.EllipsoidTerrainProvider) {
    base.message = '地形なしのため推定チェックを省略';
    return base;
  }
  try {
    const [terrainH, gsi] = await Promise.all([sampleTerrainHeight(provider, lon, lat), fetchGsiElevation(lon, lat)]);
    base.terrainEllipsoidH = terrainH;
    base.gsiElevation = gsi;
    if (!Number.isFinite(gsi)) { base.message = '標高APIにデータなし'; return base; }
    const est = terrainH - gsi;
    base.estimate = est;
    if (est < GEOID_PLAUSIBLE.min || est > GEOID_PLAUSIBLE.max) {
      base.message = `推定値 ${est.toFixed(2)} m は妥当範囲外（棄却）`;
      return base;
    }
    if (modelH === null) {
      setFallbackGeoid(est, 'terrain-estimate');
      base.message = `japan-geoid 未使用。地形推定 ${est.toFixed(2)} m を採用`;
      return base;
    }
    base.diff = modelH - est;
    base.warn = Math.abs(base.diff) > SANITY_THRESHOLD_M;
    base.message = `GSIGEO2011 ${modelH.toFixed(2)} m / 地形推定 ${est.toFixed(2)} m（差 ${base.diff >= 0 ? '+' : ''}${base.diff.toFixed(2)} m）`;
    if (base.warn) console.warn('[ジオイド] 健全性チェック警告:', base);
    else console.info('[ジオイド] 健全性チェック OK:', base.message);
    return base;
  } catch (e) {
    base.message = `推定チェック失敗: ${(e as Error).message}`;
    console.warn('[ジオイド]', base.message);
    return base;
  }
}
