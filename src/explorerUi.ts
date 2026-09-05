import type { Municipality } from './data';

export type ExplorerState = {caseId: string; mode: 'max' | 'arrival'; minutes: number; opacity: number; buildings: boolean; photo: boolean; lite: boolean};
export type ExplorerCallbacks = {onChange(state: ExplorerState): void; onCity(code: string): void; onOverview(): void; onView(top: boolean): void; onShare(): void};
const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`UI要素が見つかりません: ${id}`);
  return node as T;
};
export function initExplorerUi(options: {municipalities: Municipality[]; cases: {id: string; label: string}[]; initial?: Partial<ExplorerState>}, callbacks: ExplorerCallbacks) {
  const cases = options.cases;
  let state: ExplorerState = {caseId: cases[0]?.id ?? '', mode: 'max', minutes: 30, opacity: .75, buildings: true, photo: false, lite: false, ...options.initial};
  const caseSelect = el<HTMLSelectElement>('caseSelect');
  const search = el<HTMLInputElement>('muniSearch');
  const citySelect = el<HTMLSelectElement>('muniSelect');
  const fly = el<HTMLButtonElement>('flyToButton');
  const max = el<HTMLInputElement>('modeMax'), arrival = el<HTMLInputElement>('modeArrival');
  const minutes = el<HTMLInputElement>('minutesSlider'), opacity = el<HTMLInputElement>('opacitySlider');
  const buildings = el<HTMLInputElement>('buildingsToggle'), photo = el<HTMLInputElement>('photoToggle'), lite = el<HTMLInputElement>('liteToggle');
  caseSelect.replaceChildren(...cases.map(c => new Option(c.label, c.id)));
  caseSelect.disabled = cases.length === 0;
  max.disabled=arrival.disabled=cases.length===0;
  const normalize = () => {
    if (!cases.some(c => c.id === state.caseId)) state.caseId = cases[0]?.id ?? '';
    if (state.mode !== 'arrival') state.mode = 'max';
    state.minutes = Number.isFinite(state.minutes) ? Math.max(0, Math.min(720, state.minutes)) : 30;
    state.opacity = Number.isFinite(state.opacity) ? Math.max(0, Math.min(1, state.opacity)) : .75;
  };
  const render = () => {
    normalize();
    caseSelect.value = state.caseId; max.checked = state.mode === 'max'; arrival.checked = state.mode === 'arrival';
    el('arrivalControls').hidden = state.mode !== 'arrival';
    minutes.value = String(state.minutes); el<HTMLOutputElement>('minutesOutput').value = `${state.minutes} 分`;
    opacity.value = String(Math.round(state.opacity * 100)); el<HTMLOutputElement>('opacityOutput').value = `${Math.round(state.opacity * 100)}%`;
    buildings.checked = state.buildings; photo.checked = state.photo; lite.checked = state.lite;
  };
  let playback: ReturnType<typeof setInterval> | undefined;
  const play = el<HTMLButtonElement>('playArrival');
  const stopPlayback = () => { if(playback)clearInterval(playback);playback=undefined;play.textContent='到達範囲を再生 ▶';play.setAttribute('aria-pressed','false'); };
  const change = (patch: Partial<ExplorerState>) => { if(patch.caseId !== undefined || patch.mode === 'max')stopPlayback(); state = {...state, ...patch}; render(); callbacks.onChange({...state}); };
  play.addEventListener('click', () => {
    if(playback){stopPlayback();return;}
    if(state.minutes>=720)change({minutes:0});
    play.textContent='再生を停止 ■';play.setAttribute('aria-pressed','true');
    playback=setInterval(()=>{change({minutes:Math.min(720,state.minutes+5)});if(state.minutes>=720)stopPlayback();},800);
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPlayback();});
  caseSelect.addEventListener('change', () => change({caseId: caseSelect.value}));
  max.addEventListener('change', () => { if (max.checked) change({mode: 'max'}); });
  arrival.addEventListener('change', () => { if (arrival.checked) change({mode: 'arrival'}); });
  minutes.addEventListener('input', () => change({minutes: Number(minutes.value)}));
  opacity.addEventListener('input', () => change({opacity: Number(opacity.value) / 100}));
  buildings.addEventListener('change', () => change({buildings: buildings.checked}));
  photo.addEventListener('change', () => change({photo: photo.checked}));
  lite.addEventListener('change', () => change({lite: lite.checked}));
  const normalizeSearch = (s: string) => s.normalize('NFKC').replace(/[\s　]/g, '').toLowerCase();
  const renderCities = () => {
    const query = normalizeSearch(search.value);
    const found = options.municipalities.filter(m => !query || normalizeSearch(`${m.pref}${m.name}${m.code}`).includes(query));
    citySelect.replaceChildren(new Option(found.length ? '移動先の自治体を選択' : '一致する自治体がありません', ''), ...found.map(m => new Option(`${m.pref} ${m.name}`, m.code)));
    el('muniCount').textContent = `${found.length.toLocaleString('ja-JP')} 自治体`;
    if (query && found.length === 1) citySelect.value = found[0].code;
    fly.disabled = !citySelect.value;
  };
  search.addEventListener('input', renderCities);
  search.addEventListener('keydown', e => { if (e.key === 'Enter' && citySelect.value) { e.preventDefault(); callbacks.onCity(citySelect.value); } });
  citySelect.addEventListener('change', () => { fly.disabled = !citySelect.value; });
  fly.addEventListener('click', () => { if (citySelect.value) callbacks.onCity(citySelect.value); });
  document.querySelectorAll<HTMLButtonElement>('[data-city]').forEach(button => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-city]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      callbacks.onCity(button.dataset.city!);
    });
  });
  el('overviewButton').addEventListener('click', () => { document.querySelectorAll('[data-city]').forEach(b => b.setAttribute('aria-pressed', 'false')); callbacks.onOverview(); });
  el('topViewButton').addEventListener('click', () => { el('topViewButton').setAttribute('aria-pressed', 'true'); el('tiltViewButton').setAttribute('aria-pressed', 'false'); callbacks.onView(true); });
  el('tiltViewButton').addEventListener('click', () => { el('topViewButton').setAttribute('aria-pressed', 'false'); el('tiltViewButton').setAttribute('aria-pressed', 'true'); callbacks.onView(false); });
  el('shareButton').addEventListener('click', () => callbacks.onShare());
  const toggle = el<HTMLButtonElement>('panelToggle');
  toggle.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('panel-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? '場所・浸水の設定を開く ⌃' : '地図を広く見る ⌄';
  });
  renderCities(); render();
  return {
    setStatus(text: string) { const status = el('layerStatus'); status.textContent = text; status.dataset.error = String(/失敗|エラー|できません/.test(text)); },
    setReadout(text: string) { el('pointReadout').textContent = text; },
    setDataNote(text: string) { el('dataNote').textContent = text; },
    getState(): ExplorerState { return {...state}; },
    setState(partial: Partial<ExplorerState>) { state = {...state, ...partial}; render(); },
  };
}
