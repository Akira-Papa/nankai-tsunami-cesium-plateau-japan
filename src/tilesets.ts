/**
 * PLATEAU 建築物 3D Tiles レジストリのローダ（全国版）
 *
 * 正本は `shared/DATA_CONTRACT.md` §4 の `plateau_tilesets.json`（アプリでは `public/data/plateau_tilesets.json`）。
 * - `loadRegistry()` … 静的 JSON を取得して形を検証する。失敗時は同梱の 6 都市フィクスチャへフォールバック
 * - `loadRegistryWithCatalog()` … さらにデータカタログ GraphQL で URL を最新化（24 h キャッシュ・都市ごと 5 s）
 *
 * 名古屋版の区別固定リスト（`WARDS`）は廃止し、フィクスチャ（名古屋 4 区・静岡 2 区・高知・和歌山・徳島・那覇）へ置き換えた。
 */
import fixtureJson from '../scripts/fixtures/plateau_tilesets.fixture.json';
import { refreshRegistry, type RefreshOptions, type RefreshResult } from './catalog';
import type { PlateauRegistry, PlateauTilesetEntry } from './tilesetManager';

export type { PlateauRegistry, PlateauTilesetEntry } from './tilesetManager';
export type { RefreshOptions, RefreshResult, RegistrySource } from './catalog';
export { refreshRegistry, mergeRegistry, clearCatalogCache } from './catalog';

export const TERRAIN_URL = 'https://tile.plateauview.mlit.go.jp/terrain';
export const GSI_PALE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
export const GSI_PHOTO = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
/** 静的レジストリの既定パス（Vite の public/ 配下） */
export const REGISTRY_URL = `${import.meta.env?.BASE_URL ?? '/'}data/plateau_tilesets.json`.replace(/\/{2,}/g, '/');
export const REGISTRY_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// 検証・正規化
// ---------------------------------------------------------------------------
function asBbox(v: unknown): PlateauTilesetEntry['bbox'] {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [w, s, e, n] = v as number[];
  if (w > e || s > n || Math.abs(s) > 90 || Math.abs(n) > 90) return null;
  return [w, s, e, n];
}

/** 未知の JSON を `PlateauTilesetEntry` へ正規化。必須項目が欠けていれば undefined */
export function normalizeEntry(raw: unknown): PlateauTilesetEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const lod = Number(r.lod);
  const year = Number(r.year);
  if (typeof r.city_code !== 'string' || typeof r.url !== 'string' || (lod !== 1 && lod !== 2) || !Number.isFinite(year)) return undefined;
  const entry: PlateauTilesetEntry = {
    city_code: r.city_code,
    city: typeof r.city === 'string' ? r.city : r.city_code,
    pref_code: typeof r.pref_code === 'string' ? r.pref_code : r.city_code.slice(0, 2),
    pref: typeof r.pref === 'string' ? r.pref : '',
    ward_code: typeof r.ward_code === 'string' ? r.ward_code : null,
    ward: typeof r.ward === 'string' ? r.ward : null,
    lod: lod as 1 | 2,
    texture: Boolean(r.texture),
    year,
    url: r.url,
    bbox: asBbox(r.bbox),
  };
  if (typeof r.http_status === 'number') entry.http_status = r.http_status;
  return entry;
}

export function normalizeRegistry(raw: unknown, sourceLabel = 'unknown'): PlateauRegistry {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.tilesets) ? r.tilesets : [];
  const tilesets = list.map(normalizeEntry).filter((e): e is PlateauTilesetEntry => !!e);
  return {
    generated: typeof r.generated === 'string' ? r.generated : '',
    source: typeof r.source === 'string' ? r.source : sourceLabel,
    tilesets,
  };
}

/** 同梱フィクスチャ（6 都市・16 件。`scripts/fixtures/plateau_tilesets.fixture.json`） */
export const FIXTURE_REGISTRY: PlateauRegistry = normalizeRegistry(fixtureJson, 'fixture');

// ---------------------------------------------------------------------------
// 読込
// ---------------------------------------------------------------------------
export interface LoadRegistryOptions {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 取得失敗時のフォールバック。既定は `FIXTURE_REGISTRY` */
  fallback?: PlateauRegistry;
}

export interface LoadRegistryResult {
  registry: PlateauRegistry;
  source: 'static' | 'fixture';
  error?: string;
}

/** 静的レジストリ JSON を取得。失敗時はフィクスチャ（例外は投げない） */
export async function loadRegistryDetailed(opts: LoadRegistryOptions = {}): Promise<LoadRegistryResult> {
  const fallback = opts.fallback ?? FIXTURE_REGISTRY;
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) return { registry: fallback, source: 'fixture', error: 'fetch unavailable' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(opts.url ?? REGISTRY_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const registry = normalizeRegistry(await res.json(), 'static');
    if (registry.tilesets.length === 0) throw new Error('tilesets is empty');
    return { registry, source: 'static' };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e);
    console.warn('[PLATEAU registry] 静的レジストリの取得に失敗。フィクスチャを使用:', msg);
    return { registry: fallback, source: 'fixture', error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadRegistry(opts: LoadRegistryOptions = {}): Promise<PlateauRegistry> {
  return (await loadRegistryDetailed(opts)).registry;
}

/**
 * 静的レジストリを読み、データカタログで URL を最新化して返す（キャッシュ → GraphQL → 静的）。
 * カタログ側の失敗は握りつぶして静的値を返す。
 */
export async function loadRegistryWithCatalog(opts: LoadRegistryOptions & { catalog?: RefreshOptions | false } = {}): Promise<RefreshResult & { staticSource: LoadRegistryResult['source'] }> {
  const loaded = await loadRegistryDetailed(opts);
  if (opts.catalog === false) return { registry: loaded.registry, source: 'static', errors: {}, changed: 0, staticSource: loaded.source };
  try {
    const refreshed = await refreshRegistry(loaded.registry, opts.catalog ?? {});
    return { ...refreshed, staticSource: loaded.source };
  } catch (e) {
    console.warn('[PLATEAU catalog] 最新化に失敗。静的レジストリを使用:', e);
    return { registry: loaded.registry, source: 'static', errors: { '*': e instanceof Error ? e.message : String(e) }, changed: 0, staticSource: loaded.source };
  }
}
