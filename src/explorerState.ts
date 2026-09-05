export interface ShareState {
  caseId: string; mode: 'max' | 'arrival'; minutes: number; opacity: number;
  buildings: boolean; photo: boolean; lite: boolean;
}
export interface CameraState { lon: number; lat: number; height: number; heading: number; pitch: number }
const bounded = (raw: string | null, min: number, max: number, fallback: number) => {
  if (raw === null || raw.trim() === '') return fallback;
  const v = Number(raw); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};
export function readShare(search: string, caseIds: string[]): { state: ShareState; camera?: CameraState } {
  const q = new URLSearchParams(search);
  const state: ShareState = {
    caseId: caseIds.includes(q.get('case') ?? '') ? q.get('case')! : (caseIds[0] ?? ''),
    mode: q.get('mode') === 'arrival' ? 'arrival' : 'max',
    minutes: bounded(q.get('min'), 0, 720, 60), opacity: bounded(q.get('opacity'), 0, 1, .75),
    buildings: q.get('buildings') !== '0', photo: q.get('photo') === '1', lite: q.get('lite') === '1',
  };
  if (!q.has('lon') || !q.has('lat')) return { state };
  if (![q.get('lon'), q.get('lat')].every(v => v !== null && v.trim() !== '' && Number.isFinite(Number(v)))) return { state };
  return { state, camera: { lon: bounded(q.get('lon'), -180, 180, 135), lat: bounded(q.get('lat'), -85, 85, 35),
    height: bounded(q.get('height'), 100, 20000000, 60000), heading: bounded(q.get('heading'), -360, 360, 0), pitch: bounded(q.get('pitch'), -90, -5, -50) } };
}
export function shareSearch(s: ShareState, c: CameraState): string {
  const q = new URLSearchParams({case:s.caseId,mode:s.mode,min:String(s.minutes),opacity:String(s.opacity),buildings:s.buildings?'1':'0',photo:s.photo?'1':'0',lite:s.lite?'1':'0',lon:c.lon.toFixed(5),lat:c.lat.toFixed(5),height:String(Math.round(c.height)),heading:c.heading.toFixed(2),pitch:c.pitch.toFixed(2)});
  return `?${q}`;
}
