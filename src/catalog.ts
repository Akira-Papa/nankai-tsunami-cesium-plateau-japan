/**
 * PLATEAU データカタログ（GraphQL）から建築物 3D Tiles URL を都市単位で取得し、静的レジストリ
 * `plateau_tilesets.json`（`shared/DATA_CONTRACT.md` §4）へマージする。
 *
 * - エンドポイント: https://api.plateauview.mlit.go.jp/datacatalog/graphql（CORS: `access-control-allow-origin: *`）
 * - `area(code)` は市区町村コード（例 `23100` 名古屋市、`39201` 高知市）を受け、区がある政令市は `wardCode` 付きで返す。
 *   1 都市 1 リクエスト（約 1〜11 KB / 0.2 s）。REST 版 `/datacatalog/plateau-datasets` は全国 7,776 件・約 9 MB
 *   を一括返却するためブラウザからは使わない（静的レジストリの生成側＝D3 が使う）。
 * - 各リクエスト 5 s タイムアウト・同時 4 本。失敗した都市は静的レジストリの値を維持する。
 * - 結果は localStorage に 24 h キャッシュ（キー: `plateau.catalog.v2`）。
 * - GraphQL は bbox を返さないため、同じ市区の静的項目の bbox を引き継ぐ（無ければ null → 読込対象外）。
 */
import type { PlateauRegistry, PlateauTilesetEntry } from './tilesetManager';

export const CATALOG_GRAPHQL_ENDPOINT = 'https://api.plateauview.mlit.go.jp/datacatalog/graphql';
export const CATALOG_CACHE_KEY = 'plateau.catalog.v2';
export const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_TIMEOUT_MS = 5000;
export const CATALOG_CONCURRENCY = 4;

export type RegistrySource = 'catalog' | 'cache' | 'static';

export interface RefreshOptions {
  /** 更新する都市コード。既定はレジストリに含まれる全 `city_code` */
  cityCodes?: readonly string[];
  /** 1 リクエストあたり。既定 5000 ms */
  timeoutMs?: number;
  /** 既定 24 h。0 以下でキャッシュ無効 */
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  concurrency?: number;
  /** テスト用差し替え。既定は `globalThis.fetch` */
  fetchImpl?: typeof fetch;
  /** テスト用差し替え。既定は `globalThis.localStorage`（未定義環境では自動で無効） */
  storage?: Storage | null;
  endpoint?: string;
  now?: () => number;
}

export interface RefreshResult {
  registry: PlateauRegistry;
  source: RegistrySource;
  fetchedAt?: number;
  /** 都市コード → 失敗理由 */
  errors: Record<string, string>;
  /** URL が更新・追加された件数 */
  changed: number;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------
/** 注: スキーマ上のフィールド名は `registerationYear`（原文ママのスペル） */
const QUERY = `query CityBldg($code: AreaCode!) {
  area(code: $code) {
    code
    name
    ... on City {
      prefecture { code name }
      datasets(input: { includeTypes: ["bldg"] }) {
        id
        year
        registerationYear
        ... on PlateauDataset {
          wardCode
          ward { code name }
          items { id lod texture format url latestUrl }
        }
      }
    }
  }
}`;

interface GqlItem { id: string; lod: number | null; texture: 'TEXTURE' | 'NONE' | null; format: string; url: string; latestUrl: string | null }
interface GqlDataset { id: string; year: number | null; registerationYear: number | null; wardCode: string | null; ward: { code: string; name: string } | null; items: GqlItem[] }
interface GqlResponse {
  data?: { area?: { code: string; name: string; prefecture?: { code: string; name: string } | null; datasets?: GqlDataset[] } | null };
  errors?: { message: string }[];
}

export function isTilesetUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https:\/\/\S+\/tileset\.json$/.test(u);
}

/** 1 都市分の建築物項目を取得（bbox は null） */
export async function fetchCityBuildings(
  cityCode: string,
  opts: { fetchImpl: typeof fetch; timeoutMs?: number; endpoint?: string } ,
): Promise<PlateauTilesetEntry[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? CATALOG_TIMEOUT_MS);
  try {
    const res = await opts.fetchImpl(opts.endpoint ?? CATALOG_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { code: cityCode } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as GqlResponse;
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
    const area = json.data?.area;
    if (!area) throw new Error('area not found');
    const out: PlateauTilesetEntry[] = [];
    for (const d of area.datasets ?? []) {
      if (typeof d.year !== 'number') continue;
      for (const it of d.items ?? []) {
        if (it.format !== 'CESIUM3DTILES' || (it.lod !== 1 && it.lod !== 2) || !isTilesetUrl(it.url)) continue;
        out.push({
          city_code: area.code,
          city: area.name,
          pref_code: area.prefecture?.code ?? cityCode.slice(0, 2),
          pref: area.prefecture?.name ?? '',
          ward_code: d.wardCode ?? d.ward?.code ?? null,
          ward: d.ward?.name ?? null,
          lod: it.lod,
          texture: it.texture === 'TEXTURE',
          year: d.year,
          url: it.url,
          bbox: null,
        });
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// マージ
// ---------------------------------------------------------------------------
const key = (e: PlateauTilesetEntry) => `${e.ward_code ?? e.city_code}|${e.lod}|${e.texture ? 't' : 'n'}|${e.year}`;

/**
 * 静的レジストリへカタログ項目をマージする（純関数）。
 * - 同一 (市区, lod, texture, year) は URL を差し替え（bbox・都市名は静的側を維持）
 * - 新規の組合せは追加。bbox は同じ市区の静的項目から引き継ぐ（無ければ null）
 * - `cities` に含まれない都市の静的項目、カタログに無くなった静的項目はそのまま残す
 */
export function mergeRegistry(base: PlateauRegistry, fetched: readonly PlateauTilesetEntry[]): { registry: PlateauRegistry; changed: number } {
  const byKey = new Map(base.tilesets.map((e) => [key(e), e] as const));
  const bboxByGroup = new Map<string, PlateauTilesetEntry['bbox']>();
  for (const e of base.tilesets) {
    const g = e.ward_code ?? e.city_code;
    if (e.bbox && !bboxByGroup.get(g)) bboxByGroup.set(g, e.bbox);
  }
  const tilesets = base.tilesets.map((e) => ({ ...e }));
  let changed = 0;
  for (const f of fetched) {
    const k = key(f);
    const cur = byKey.get(k);
    if (cur) {
      if (cur.url !== f.url) {
        const idx = tilesets.findIndex((e) => key(e) === k);
        tilesets[idx] = { ...cur, url: f.url, http_status: undefined };
        delete tilesets[idx].http_status;
        changed++;
      }
    } else {
      const bbox = f.bbox ?? bboxByGroup.get(f.ward_code ?? f.city_code) ?? null;
      const pref = f.pref || base.tilesets.find((e) => e.city_code === f.city_code)?.pref || '';
      tilesets.push({ ...f, pref, bbox });
      byKey.set(k, f);
      changed++;
    }
  }
  return { registry: { ...base, tilesets }, changed };
}

// ---------------------------------------------------------------------------
// localStorage キャッシュ
// ---------------------------------------------------------------------------
interface CacheRecord { v: 2; savedAt: number; cities: Record<string, PlateauTilesetEntry[]> }

function getStorage(opt: RefreshOptions['storage']): Storage | null {
  if (opt !== undefined) return opt;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function readCache(storage: Storage | null, ttl: number, now: number): CacheRecord | null {
  if (!storage || ttl <= 0) return null;
  try {
    const raw = storage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<CacheRecord>;
    if (rec.v !== 2 || typeof rec.savedAt !== 'number' || !rec.cities || typeof rec.cities !== 'object') return null;
    if (now - rec.savedAt > ttl) return null;
    return rec as CacheRecord;
  } catch { return null; }
}

function writeCache(storage: Storage | null, cities: Record<string, PlateauTilesetEntry[]>, now: number): void {
  if (!storage) return;
  try { storage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ v: 2, savedAt: now, cities } satisfies CacheRecord)); } catch { /* 容量超過などは無視 */ }
}

export function clearCatalogCache(storage?: Storage | null): void {
  try { getStorage(storage)?.removeItem(CATALOG_CACHE_KEY); } catch { /* noop */ }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }));
  return results;
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------
/**
 * 静的レジストリをデータカタログで最新化する。
 * 優先順: localStorage キャッシュ（24 h 以内・全都市揃っている場合） → GraphQL（都市ごと 5 s） → 静的値。
 * 一部都市だけ失敗した場合はその都市の静的値を維持し、`errors` に理由を残す（例外は投げない）。
 */
export async function refreshRegistry(base: PlateauRegistry, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const now = opts.now ?? Date.now;
  const storage = getStorage(opts.storage);
  const ttl = opts.cacheTtlMs ?? CATALOG_CACHE_TTL_MS;
  const cityCodes = [...new Set(opts.cityCodes ?? base.tilesets.map((e) => e.city_code))];
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  const staticResult = (errors: Record<string, string>): RefreshResult => ({ registry: base, source: 'static', errors, changed: 0 });
  if (cityCodes.length === 0) return staticResult({});

  if (!opts.forceRefresh) {
    const cached = readCache(storage, ttl, now());
    if (cached && cityCodes.every((c) => Array.isArray(cached.cities[c]))) {
      const merged = mergeRegistry(base, cityCodes.flatMap((c) => cached.cities[c]));
      return { ...merged, source: 'cache', fetchedAt: cached.savedAt, errors: {} };
    }
  }
  if (!fetchImpl) return staticResult({ '*': 'fetch unavailable' });

  const errors: Record<string, string> = {};
  const cities: Record<string, PlateauTilesetEntry[]> = {};
  await mapLimit(cityCodes, opts.concurrency ?? CATALOG_CONCURRENCY, async (code) => {
    try {
      cities[code] = await fetchCityBuildings(code, { fetchImpl, timeoutMs: opts.timeoutMs, endpoint: opts.endpoint });
    } catch (e) {
      errors[code] = e instanceof Error ? (e.name === 'AbortError' ? `timeout ${opts.timeoutMs ?? CATALOG_TIMEOUT_MS} ms` : e.message) : String(e);
    }
  });
  const fetchedCodes = Object.keys(cities);
  if (fetchedCodes.length === 0) {
    console.warn('[PLATEAU catalog] 取得失敗。静的レジストリを使用:', errors);
    return staticResult(errors);
  }
  const fetchedAt = now();
  if (Object.keys(errors).length === 0) writeCache(storage, cities, fetchedAt); // 全都市揃った時だけキャッシュ
  const merged = mergeRegistry(base, fetchedCodes.flatMap((c) => cities[c]));
  return { ...merged, source: 'catalog', fetchedAt, errors };
}
