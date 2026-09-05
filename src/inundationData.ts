export type InundationCell = { lon: number; lat: number; depthM: number; arrivalSec: number | null; sizeM: number; sampleCount?: number };
export type Bbox = [number, number, number, number];
export type InundationLevel = { resolutionM: number; tiles: { path: string; bounds: Bbox; count: number }[]; count: number };
export type InundationCase = { id: string; label: string; available: boolean; bounds: Bbox; sourceUrl: string; sourceRows: number; levels: InundationLevel[] };
export type InundationManifest = { version: number; source: string; sourceUrl: string; licenseUrl: string; originalResolutionM: number; coordinateSystem: string; depthDefinition: string; arrivalDefinition: string; aggregation: string; cases: InundationCase[] };
let manifestPromise: Promise<InundationManifest> | undefined;
const cache = new Map<string, InundationCell[]>();
async function fetchJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(path, { signal: controller.signal });
    if (!r.ok) throw new Error(`浸水データ取得失敗 (${r.status})`);
    return await r.json();
  } finally { clearTimeout(timeout); }
}
function validBounds(value: unknown): value is Bbox {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[0]>=-180 && value[2]<=180 && value[1]>=-90 && value[3]<=90 && value[0]<=value[2] && value[1]<=value[3];
}
export function validateManifest(value: unknown): InundationManifest {
  const m=value as InundationManifest;
  if(!m || m.version!==1 || !Array.isArray(m.cases))throw new Error('浸水データ形式が不正です');
  const ids=new Set<string>();
  for(const c of m.cases) {
    if(!c || typeof c.id!=='string' || !/^\d+$/.test(c.id) || ids.has(c.id) || typeof c.available!=='boolean' || !Array.isArray(c.levels))throw new Error('浸水ケース形式が不正です');
    ids.add(c.id);
    if(c.available && (typeof c.label!=='string' || !validBounds(c.bounds) || c.levels.length===0))throw new Error('浸水ケース定義が不正です');
    for(const l of c.levels) {
      if(![100,500,2500].includes(l.resolutionM) || !Array.isArray(l.tiles))throw new Error('浸水解像度が不正です');
      for(const t of l.tiles) {
        if(!t || typeof t.path!=='string' || !/^\d+\/(100|500|2500)\/-?\d+_-?\d+\.json$/.test(t.path) || !t.path.startsWith(`${c.id}/${l.resolutionM}/`) || !validBounds(t.bounds) || !Number.isSafeInteger(t.count) || t.count<0)throw new Error('浸水タイル定義が不正です');
      }
    }
  }
  return m;
}
export function loadManifest(): Promise<InundationManifest> {
  return manifestPromise ??= fetchJson('/inundation/manifest.json').then(validateManifest).catch(e=>{manifestPromise=undefined;throw e;});
}
export function intersects(a: Bbox, b: Bbox, margin = 0): boolean { return a[0] <= b[2]+margin && a[2] >= b[0]-margin && a[1] <= b[3]+margin && a[3] >= b[1]-margin; }
export function decodeCells(rows: unknown, sizeM: number): InundationCell[] {
  if (!Number.isFinite(sizeM) || sizeM <= 0) throw new Error('浸水解像度が不正です');
  if (!Array.isArray(rows)) throw new Error('浸水タイル形式が不正です');
  return rows.map((r: unknown) => {
    if (!Array.isArray(r) || r.length < 4 || ![r[0],r[1],r[2]].every(Number.isFinite) || r[0]<-180 || r[0]>180 || r[1]<-90 || r[1]>90 || r[2] <= 0 || (r[3] !== null && (!Number.isFinite(r[3]) || r[3]<0))) throw new Error('浸水セル値が不正です');
    return { lon:r[0],lat:r[1],depthM:r[2],arrivalSec:r[3],sizeM,sampleCount:r[4] };
  });
}
export async function loadView(caseId: string, bbox: Bbox, level = 500): Promise<{ cells: InundationCell[]; resolutionM: number; truncated: boolean; aggregated: true }> {
  if (bbox.length!==4 || !bbox.every(Number.isFinite) || bbox[0]>bbox[2] || bbox[1]>bbox[3]) throw new Error('表示範囲が不正です');
  const m=await loadManifest();const scenario=m.cases.find(c=>c.id===String(caseId));
  if(!scenario?.available) throw new Error('選択ケースは未収録です');
  let selected=[...scenario.levels].sort((a,b)=>Math.abs(a.resolutionM-level)-Math.abs(b.resolutionM-level))[0];
  if(!selected) throw new Error('集約レベルが未収録です');
  // Bound the request and render cost by choosing a coarser level, never silently dropping tiles.
  for(const candidate of [...scenario.levels].sort((a,b)=>a.resolutionM-b.resolutionM)) {
    if(candidate.resolutionM<selected.resolutionM) continue;
    selected=candidate;
    if(candidate.tiles.filter(t=>intersects(t.bounds,bbox,candidate.resolutionM/80000)).reduce((s,t)=>s+t.count,0)<=25000)break;
  }
  const margin=selected.resolutionM/80000;
  const tiles=selected.tiles.filter(t=>intersects(t.bounds,bbox,margin));
  const result:InundationCell[]=[];
  for(let i=0;i<tiles.length;i+=8) {
    const batch=await Promise.all(tiles.slice(i,i+8).map(async t=>{
      if(cache.has(t.path))return cache.get(t.path)!;
      const cells=decodeCells(await fetchJson(`/inundation/${t.path}`),selected.resolutionM);
      cache.set(t.path,cells);if(cache.size>180)cache.delete(cache.keys().next().value!);return cells;
    }));result.push(...batch.flat());
  }
  return {cells:result.filter(c=>intersects([c.lon,c.lat,c.lon,c.lat],bbox,margin)),resolutionM:selected.resolutionM,truncated:false,aggregated:true};
}
