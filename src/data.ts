/**
 * 共有データ契約（../shared/DATA_CONTRACT.md）に対応する型と読込関数。
 *
 * - 実データは統合時に `shared/data/` から `public/data/` へ置き換える。キー名・型は契約と同一。
 * - 開発用フィクスチャ（6市町村）はトップレベルに `fixture: true` を持つ。
 * - 座標は WGS84 経緯度（度）。市区町村コードは 5 桁文字列。
 */

/** [west, south, east, north]（度） */
export type BBox = [number, number, number, number];

// ---------------------------------------------------------------------------
// §1 municipalities.json
// ---------------------------------------------------------------------------
export interface Prefecture { code: string; name: string }

export interface Municipality {
  code: string;
  name: string;
  pref_code: string;
  pref: string;
  /** 代表点（ポリゴン重心を陸側に丸めたもの） */
  lon: number;
  lat: number;
  bbox: BBox;
  /** 海岸線を持つ */
  coastal: boolean;
  /** 内閣府2025「市町村別一覧表」に掲載がある */
  nankai_target: boolean;
  /** 政令市の区コード配列（政令市以外は省略または空） */
  wards?: string[];
}

export interface MunicipalitiesFile {
  generated: string;
  source: { n03: string; license: string };
  prefectures: Prefecture[];
  municipalities: Municipality[];
  fixture?: boolean;
}

// ---------------------------------------------------------------------------
// §2 municipalities_coastal.geojson
// ---------------------------------------------------------------------------
export type Position = [number, number] | [number, number, number];
export type PolygonCoordinates = Position[][];
export type MultiPolygonCoordinates = Position[][][];

export interface MunicipalityProps { code: string; name: string; pref_code: string; pref: string }

export interface PolygonGeometry { type: 'Polygon'; coordinates: PolygonCoordinates }
export interface MultiPolygonGeometry { type: 'MultiPolygon'; coordinates: MultiPolygonCoordinates }
export type MunicipalityGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface MunicipalityFeature {
  type: 'Feature';
  id?: string | number;
  properties: MunicipalityProps;
  geometry: MunicipalityGeometry;
  bbox?: BBox;
}

export interface MunicipalitiesGeoJSON {
  type: 'FeatureCollection';
  features: MunicipalityFeature[];
  fixture?: boolean;
  bbox?: BBox;
}

// ---------------------------------------------------------------------------
// §3 tsunami_h.json
// ---------------------------------------------------------------------------
export interface TsunamiRow {
  /** 一意に決まらない場合は null（note に理由） */
  code: string | null;
  pref: string;
  name: string;
  max_2025: number | null;
  mean_2025: number | null;
  /** ケース番号("1"〜"11") → 津波高（m）。抽出不能セルは null */
  cases_2025: Record<string, number | null>;
  max_2012: number | null;
  area_ha_2025: number | null;
  raw_name: string;
  note: string;
}

export interface TsunamiFile {
  generated: string;
  source: { '2025': string; '2012': string; license: string };
  unit: string;
  cases: string[];
  rows: TsunamiRow[];
  fixture?: boolean;
}

/** UI プリセット → `TsunamiRow` の数値キー */
export type TsunamiPreset = 'max_2025' | 'mean_2025' | 'max_2012';

// ---------------------------------------------------------------------------
// §4 plateau_tilesets.json
// ---------------------------------------------------------------------------
export interface PlateauTileset {
  city_code: string;
  city: string;
  pref_code: string;
  pref: string;
  ward_code: string | null;
  ward: string | null;
  lod: number;
  texture: boolean;
  year: number;
  url: string;
  /** tileset.json の root.boundingVolume.region を度へ変換。取得失敗時は null */
  bbox: BBox | null;
  http_status: number | null;
}

export interface PlateauRegistry {
  generated: string;
  source: string;
  tilesets: PlateauTileset[];
  fixture?: boolean;
}

// ---------------------------------------------------------------------------
// 読込
// ---------------------------------------------------------------------------
export interface AppData {
  municipalities: MunicipalitiesFile;
  coastal: MunicipalitiesGeoJSON;
  tsunami: TsunamiFile;
  registry: PlateauRegistry;
  /** いずれかのファイルが `fixture: true` */
  isFixture: boolean;
}

export const DATA_FILES = {
  municipalities: 'municipalities.json',
  coastal: 'municipalities_coastal.geojson',
  tsunami: 'tsunami_h.json',
  registry: 'plateau_tilesets.json',
} as const;

export class DataLoadError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'DataLoadError';
  }
}

async function fetchJson<T>(url: string, file: string, validate: (v: unknown) => v is T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'default' });
  } catch (e) {
    throw new DataLoadError(file, `ネットワークエラー: ${(e as Error).message}`);
  }
  if (!res.ok) throw new DataLoadError(file, `HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new DataLoadError(file, `JSON 解析失敗: ${(e as Error).message}`);
  }
  if (!validate(json)) throw new DataLoadError(file, '契約スキーマと一致しません');
  return json;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isBBox = (v: unknown): v is BBox => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

export function isMunicipalitiesFile(v: unknown): v is MunicipalitiesFile {
  return isObj(v) && Array.isArray(v.municipalities) && Array.isArray(v.prefectures)
    && v.municipalities.every((m: unknown) => isObj(m) && typeof m.code === 'string' && typeof m.name === 'string'
      && typeof m.lon === 'number' && typeof m.lat === 'number' && isBBox(m.bbox));
}

export function isMunicipalitiesGeoJSON(v: unknown): v is MunicipalitiesGeoJSON {
  return isObj(v) && v.type === 'FeatureCollection' && Array.isArray(v.features)
    && v.features.every((f: unknown) => isObj(f) && f.type === 'Feature' && isObj(f.properties) && typeof f.properties.code === 'string'
      && isObj(f.geometry) && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') && Array.isArray(f.geometry.coordinates));
}

export function isTsunamiFile(v: unknown): v is TsunamiFile {
  return isObj(v) && Array.isArray(v.rows) && Array.isArray(v.cases)
    && v.rows.every((r: unknown) => isObj(r) && (typeof r.code === 'string' || r.code === null) && typeof r.name === 'string');
}

export function isPlateauRegistry(v: unknown): v is PlateauRegistry {
  return isObj(v) && Array.isArray(v.tilesets)
    && v.tilesets.every((t: unknown) => isObj(t) && typeof t.city_code === 'string' && typeof t.url === 'string' && typeof t.lod === 'number');
}

/**
 * 4 ファイルを並列取得する。`base` は `public/data/` の配信 URL（既定: `${import.meta.env.BASE_URL}data/`）。
 * 1 つでも失敗すれば `DataLoadError` を投げる（部分的に動かすより、起動時に明確に失敗させる）。
 */
export async function loadAll(base: string = `${import.meta.env.BASE_URL}data/`): Promise<AppData> {
  const b = base.endsWith('/') ? base : `${base}/`;
  // 沿岸ポリゴンは一枚ファイル（14.7 MB）を起動時に読まず、都道府県別 `coastal/{pref_code}.geojson` を
  // 表示範囲に応じて `loadCoastalPref()` で遅延取得する（初期表示の転送量・パース時間対策）
  const [municipalities, tsunami, registry] = await Promise.all([
    fetchJson(b + DATA_FILES.municipalities, DATA_FILES.municipalities, isMunicipalitiesFile),
    fetchJson(b + DATA_FILES.tsunami, DATA_FILES.tsunami, isTsunamiFile),
    fetchJson(b + DATA_FILES.registry, DATA_FILES.registry, isPlateauRegistry),
  ]);
  const coastal: MunicipalitiesGeoJSON = { type: 'FeatureCollection', features: [] };
  const isFixture = !!(municipalities.fixture || tsunami.fixture || registry.fixture);
  if (isFixture) console.warn('[data] フィクスチャデータ（6市町村）で動作しています。統合時に shared/data/ の実データへ置き換えてください。');
  return { municipalities, coastal, tsunami, registry, isFixture };
}

const coastalPrefCache = new Map<string, Promise<MunicipalitiesGeoJSON | null>>();

/**
 * 都道府県別の沿岸ポリゴン `coastal/{pref_code}.geojson` を取得する（同じ県は1回だけ。失敗時 null）。
 */
export function loadCoastalPref(prefCode: string, base: string = `${import.meta.env.BASE_URL}data/`): Promise<MunicipalitiesGeoJSON | null> {
  const cached = coastalPrefCache.get(prefCode);
  if (cached) return cached;
  const b = base.endsWith('/') ? base : `${base}/`;
  const p = fetchJson(`${b}coastal/${prefCode}.geojson`, `coastal/${prefCode}.geojson`, isMunicipalitiesGeoJSON)
    .catch((e) => { console.warn('[coastal]', prefCode, e); coastalPrefCache.delete(prefCode); return null; });
  coastalPrefCache.set(prefCode, p);
  return p;
}

// ---------------------------------------------------------------------------
// 小さなユーティリティ（アプリ側で共通に使う）
// ---------------------------------------------------------------------------
/** 市区町村コード → 津波高行。政令市の区コード（例 23111）は市コード（23100）の行へ寄せる */
export function findTsunamiRow(tsunami: TsunamiFile, code: string | null | undefined): TsunamiRow | undefined {
  if (!code) return undefined;
  const direct = tsunami.rows.find((r) => r.code === code);
  if (direct) return direct;
  if (/^\d{2}1\d{2}$/.test(code) && !code.endsWith('00')) {
    // 政令市の区 → 市コード
    const city = tsunami.rows.find((r) => r.code === `${code.slice(0, 3)}00`);
    if (city) return city;
  }
  if (/^\d{3}00$/.test(code)) {
    // 政令市の市コード → 内閣府一覧が区単位（例: 名古屋市港区 23111）の場合は区の値を合成（最大値）
    const prefix = code.slice(0, 3);
    const wardRows = tsunami.rows.filter((r) => r.code && r.code.startsWith(prefix) && r.code !== code);
    if (wardRows.length) return mergeWardRows(code, wardRows);
  }
  return undefined;
}

function maxOfNums(vals: (number | null | undefined)[]): number | null {
  const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

/** 区別の行から市代表値（最大値。浸水面積は合計）を作る */
function mergeWardRows(cityCode: string, rows: TsunamiRow[]): TsunamiRow {
  const cases: Record<string, number | null> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.cases_2025 ?? {})) cases[k] = maxOfNums([cases[k], v]);
  }
  const first = rows[0];
  const cityName = first.name.replace(/[^\s]*区$/, '').replace(/市.*$/, '市') || first.name;
  return {
    ...first,
    code: cityCode,
    name: cityName,
    max_2025: maxOfNums(rows.map((r) => r.max_2025)),
    mean_2025: maxOfNums(rows.map((r) => r.mean_2025)),
    cases_2025: cases,
    max_2012: maxOfNums(rows.map((r) => r.max_2012)),
    area_ha_2025: rows.reduce<number | null>((a, r) => (r.area_ha_2025 == null ? a : (a ?? 0) + r.area_ha_2025), null),
    raw_name: rows.map((r) => r.raw_name ?? r.name).join('/'),
    note: `区別の値から合成（最大値・面積は合計）: ${rows.map((r) => r.name).join('、')}`,
  };
}

/** プリセットに応じた津波高（m, T.P.）。値が無ければ null */
export function tsunamiHeight(row: TsunamiRow | undefined, preset: TsunamiPreset): number | null {
  if (!row) return null;
  const v = row[preset];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function findMunicipality(file: MunicipalitiesFile, code: string | null | undefined): Municipality | undefined {
  if (!code) return undefined;
  return file.municipalities.find((m) => m.code === code) ?? file.municipalities.find((m) => m.wards?.includes(code));
}

/** 2 つの bbox が交差するか（margin は度） */
export function bboxIntersects(a: BBox, b: BBox, margin = 0): boolean {
  return a[0] - margin <= b[2] && a[2] + margin >= b[0] && a[1] - margin <= b[3] && a[3] + margin >= b[1];
}

/** GeoJSON ジオメトリから bbox を計算 */
export function geometryBBox(g: MunicipalityGeometry): BBox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const rings: Position[][] = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  for (const ring of rings) for (const p of ring) {
    if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}
