import { findTsunamiRow } from './data';
import { TSUNAMI_CASES, findCase, JMA_INTENSITY, findIntensity } from './scenarios';
/**
 * UI モジュール（全国版 南海トラフ津波ビジュアライザ／CesiumJS 版）
 *
 * - DOM の生成・更新はすべてこのファイルと index.html の静的骨格で完結する（main.ts は DOM を触らない）
 * - main.ts は `initUi()` に市区町村一覧・津波高一覧を渡し、返却ハンドルで状態を読み書きする
 * - `tsunami.rows` が空でも、`municipalities` が空でも例外なく動作する（フィクスチャ非依存）
 * - URL クエリ `?m=<市区町村コード>&h=<津波高 m>` を初期値として読み、変更時に `history.replaceState` で反映する
 *
 * 型は shared/DATA_CONTRACT.md §1／§3 と構造互換になるようにここでも宣言する（`./data` の有無に依存しない）。
 */

// ---------------------------------------------------------------------------
// データ型（DATA_CONTRACT §1／§3 と構造互換。A1 側の ./data の型はこれらへ代入可能）
// ---------------------------------------------------------------------------
export interface Prefecture { code: string; name: string }
export interface Municipality {
  code: string;
  name: string;
  pref_code: string;
  pref: string;
  lon: number;
  lat: number;
  bbox?: number[] | null;
  coastal?: boolean;
  nankai_target?: boolean;
  wards?: string[] | null;
}
export interface MunicipalitiesFile {
  generated?: string;
  source?: unknown;
  prefectures: Prefecture[];
  municipalities: Municipality[];
}
export interface TsunamiRow {
  code: string | null;
  pref?: string | null;
  name: string;
  max_2025: number | null;
  mean_2025: number | null;
  cases_2025?: Record<string, number | null> | null;
  max_2012: number | null;
  area_ha_2025: number | null;
  raw_name?: string | null;
  note?: string | null;
}
export interface TsunamiFile {
  generated?: string;
  source?: unknown;
  unit?: string;
  cases?: string[];
  rows: TsunamiRow[];
}

// ---------------------------------------------------------------------------
// 公開インターフェース
// ---------------------------------------------------------------------------
/** `case` = 上で選んだ内閣府 津波ケース（①〜⑪）の市町村別最大津波高 */
export type Preset = 'max_2025' | 'mean_2025' | 'max_2012' | 'case' | 'manual';
export type Imagery = 'pale' | 'photo';
/** 表示品質。auto = 端末性能から自動判定（localStorage に保存） */
export type Quality = 'auto' | 'high' | 'standard' | 'lite';
export const QUALITY_STORAGE_KEY = 'nankai-cesium.quality';

export interface UiState {
  muniCode: string | null;
  heightM: number;
  preset: Preset;
  /** 内閣府 津波ケース "1".."11"。null = 指定なし（最大値ベース） */
  caseId: string | null;
  /** 参考表示の震度階級キー（'5-' 等）。地図表示には影響しない */
  intensity: string | null;
  showOfficial: boolean;
  showBuildings: boolean;
  lod2: boolean;
  imagery: Imagery;
  showWater: boolean;
  quality: Quality;
}

export interface UiCallbacks {
  onChange(s: UiState): void;
  onFlyTo(code: string): void;
  onResetView(): void;
  /** 「震源域と市区町村を一画面に」（任意） */
  onFitCase?(): void;
}

export interface UiHandle {
  setState(p: Partial<UiState>): void;
  setStatus(text: string): void;
  setBanner(msg: string | null, level?: 'warn' | 'error'): void;
  setReadout(text: string | null): void;
  getState(): UiState;
  /** 品質セレクタ横の補足（例: 自動判定の結果） */
  setQualityNote?(text: string): void;
}

/** スライダーの範囲（DATA_CONTRACT §6: 0〜35 m・0.1 刻み） */
export const HEIGHT_MIN = 0;
export const HEIGHT_MAX = 35;
export const HEIGHT_STEP = 0.1;

const PRESET_LABEL: Record<Preset, string> = {
  max_2025: '2025 最大',
  mean_2025: '2025 平均',
  max_2012: '2012 最大',
  case: 'ケース別',
  manual: '手動',
};
const PRESET_ORDER: Preset[] = ['max_2025', 'mean_2025', 'max_2012', 'case', 'manual'];

const DEFAULT_STATE: UiState = {
  muniCode: null,
  heightM: 5.0,
  preset: 'max_2025',
  caseId: null,
  intensity: null,
  showOfficial: false,
  showBuildings: true,
  lod2: false,
  imagery: 'pale',
  showWater: true,
  quality: 'auto',
};

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------
function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} が index.html に存在しません（ui.ts が要求する要素）`);
  return el as T;
}

function clampHeight(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_STATE.heightM;
  const r = Math.round(v / HEIGHT_STEP) * HEIGHT_STEP;
  return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.round(r * 10) / 10));
}

function fmtM(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} m` : 'データなし';
}
function fmtHa(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v).toLocaleString('ja-JP')} ha` : 'データなし';
}

/** 検索用の正規化（全角英数→半角、空白除去、小文字化）。カナ・漢字はそのまま部分一致 */
function norm(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isTarget(m: Municipality): boolean {
  return !!(m.nankai_target || m.coastal);
}

function presetValue(row: TsunamiRow | undefined, p: Preset, caseId: string | null = null): number | null {
  if (!row || p === 'manual') return null;
  if (p === 'case') {
    const v = caseId ? row.cases_2025?.[caseId] : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  const v = row[p];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
export function initUi(
  data: { municipalities: MunicipalitiesFile; tsunami: TsunamiFile },
  cb: UiCallbacks,
  initial: Partial<UiState> = {},
): UiHandle {
  // ---- データ索引（欠損に寛容） -------------------------------------------
  const munis: Municipality[] = (data.municipalities?.municipalities ?? []).filter(isTarget);
  const muniByCode = new Map<string, Municipality>();
  const parentOfWard = new Map<string, string>();
  for (const m of munis) {
    muniByCode.set(m.code, m);
    for (const w of m.wards ?? []) parentOfWard.set(w, m.code);
  }
  const prefNames = new Map<string, string>();
  for (const p of data.municipalities?.prefectures ?? []) prefNames.set(p.code, p.name);
  for (const m of munis) if (!prefNames.has(m.pref_code)) prefNames.set(m.pref_code, m.pref);
  // 対象市区町村を1件以上持つ都道府県のみ（コード順）
  const prefCodes = [...new Set(munis.map((m) => m.pref_code))].sort();

  const rows: TsunamiRow[] = data.tsunami?.rows ?? [];
  const rowByCode = new Map<string, TsunamiRow>();
  for (const r of rows) if (r.code) rowByCode.set(r.code, r);
  const unit = data.tsunami?.unit ?? 'm（T.P.基準）';

  /** 市区町村コード → 津波高行。コード不一致時は 都道府県名＋市区町村名 で救済 */
  function findRow(code: string | null): TsunamiRow | undefined {
    if (!code) return undefined;
    const direct = rowByCode.get(code);
    if (direct) return direct;
    const m = muniByCode.get(code);
    if (!m) return undefined;
    // 政令市: 内閣府一覧が区単位（例: 名古屋市港区 23111）なら区の値を合成（data.ts と同じ規則）
    if (data.tsunami) {
      const merged = findTsunamiRow(data.tsunami as never, code);
      if (merged) return merged as TsunamiRow;
    }
    return rows.find((r) => r.name === m.name && (!r.pref || r.pref === m.pref));
  }

  /** 区コードなら親の政令市コードへ正規化。対象外・未知のコードは null */
  function normalizeCode(code: string | null | undefined): string | null {
    if (!code) return null;
    if (muniByCode.has(code)) return code;
    const parent = parentOfWard.get(code);
    return parent ?? null;
  }

  // ---- DOM 参照（すべて index.html の静的骨格） ------------------------------
  const prefSelect = $<HTMLSelectElement>('prefSelect');
  const muniSearch = $<HTMLInputElement>('muniSearch');
  const muniSelect = $<HTMLSelectElement>('muniSelect');
  const flyToBtn = $<HTMLButtonElement>('flyTo');
  const muniCount = $<HTMLSpanElement>('muniCount');

  const tsName = $<HTMLElement>('tsMuniName');
  const tsMax2025 = $<HTMLElement>('tsMax2025');
  const tsMean2025 = $<HTMLElement>('tsMean2025');
  const tsMax2012 = $<HTMLElement>('tsMax2012');
  const tsArea = $<HTMLElement>('tsArea');
  const tsNote = $<HTMLElement>('tsNote');
  const tsUnit = $<HTMLElement>('tsUnit');

  const caseSelect = $<HTMLSelectElement>('caseSelect');
  const caseDesc = $<HTMLElement>('caseDesc');
  const caseMapLegend = $<HTMLElement>('caseMapLegend');
  const caseFit = $<HTMLButtonElement>('caseFit');
  const intensitySelect = $<HTMLSelectElement>('intensitySelect');
  const intensityDesc = $<HTMLElement>('intensityDesc');

  const presetsEl = $<HTMLDivElement>('presets');
  const slider = $<HTMLInputElement>('heightSlider');
  const heightReadout = $<HTMLOutputElement>('heightReadout');

  const officialToggle = $<HTMLInputElement>('officialToggle');
  const legend = $<HTMLElement>('legend');
  const bldgToggle = $<HTMLInputElement>('bldgToggle');
  const lod2Toggle = $<HTMLInputElement>('lod2Toggle');
  const imageryPale = $<HTMLInputElement>('imageryPale');
  const imageryPhoto = $<HTMLInputElement>('imageryPhoto');
  const waterToggle = $<HTMLInputElement>('waterToggle');
  const qualitySelect = $<HTMLSelectElement>('qualitySelect');
  const qualityNote = $<HTMLElement>('qualityNote');
  const resetViewBtn = $<HTMLButtonElement>('resetView');

  const statusEl = $<HTMLElement>('status');
  const bannerEl = $<HTMLElement>('banner');
  const readoutEl = $<HTMLElement>('readout');
  const readoutHint = $<HTMLElement>('readoutHint');
  const panel = $<HTMLElement>('panel');
  const panelToggle = $<HTMLButtonElement>('panelToggle');

  slider.min = String(HEIGHT_MIN);
  slider.max = String(HEIGHT_MAX);
  slider.step = String(HEIGHT_STEP);
  tsUnit.textContent = `単位: ${unit}`;

  // ---- 状態 ------------------------------------------------------------------
  const state: UiState = { ...DEFAULT_STATE };

  /** URL クエリ（?m= / ?h=）→ 初期値。`initial` の明示指定が常に優先 */
  function readUrl(): Partial<UiState> {
    const out: Partial<UiState> = {};
    try {
      const q = new URLSearchParams(window.location.search);
      const m = q.get('m');
      if (m && /^\d{5}$/.test(m)) out.muniCode = m;
      const c = q.get('c');
      if (c && findCase(c)) { out.caseId = c; out.preset = 'case'; }
      const si = q.get('si');
      if (si && findIntensity(si)) out.intensity = si;
      const qq = q.get('q');
      if (qq && ['auto', 'high', 'standard', 'lite'].includes(qq)) out.quality = qq as Quality;
      const h = q.get('h');
      if (h !== null && h !== '') {
        const v = parseFloat(h);
        if (Number.isFinite(v)) { out.heightM = clampHeight(v); out.preset = 'manual'; }
      }
    } catch { /* URL API 非対応環境でも UI は動かす */ }
    return out;
  }

  function syncUrl() {
    try {
      const url = new URL(window.location.href);
      if (state.muniCode) url.searchParams.set('m', state.muniCode); else url.searchParams.delete('m');
      if (state.caseId) url.searchParams.set('c', state.caseId); else url.searchParams.delete('c');
      if (state.intensity) url.searchParams.set('si', state.intensity); else url.searchParams.delete('si');
      url.searchParams.set('h', state.heightM.toFixed(1));
      const next = `${url.pathname}${url.search}${url.hash}`;
      const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next !== cur) window.history.replaceState(window.history.state, '', next);
    } catch { /* file:// や制限環境では無視 */ }
  }

  function applyPartial(p: Partial<UiState>) {
    if ('muniCode' in p) state.muniCode = normalizeCode(p.muniCode);
    if (typeof p.heightM === 'number') state.heightM = clampHeight(p.heightM);
    if ('caseId' in p) state.caseId = findCase(p.caseId)?.id ?? null;
    if ('intensity' in p) state.intensity = findIntensity(p.intensity)?.key ?? null;
    if (p.preset && PRESET_ORDER.includes(p.preset)) state.preset = p.preset;
    if (typeof p.showOfficial === 'boolean') state.showOfficial = p.showOfficial;
    if (typeof p.showBuildings === 'boolean') state.showBuildings = p.showBuildings;
    if (typeof p.lod2 === 'boolean') state.lod2 = p.lod2;
    if (p.imagery === 'pale' || p.imagery === 'photo') state.imagery = p.imagery;
    if (typeof p.showWater === 'boolean') state.showWater = p.showWater;
    if (p.quality && ['auto', 'high', 'standard', 'lite'].includes(p.quality)) state.quality = p.quality;
  }

  /** プリセットに対応する津波高を state.heightM へ反映。値が無ければ手動へ落とす */
  function applyPreset(p: Preset): void {
    const row = findRow(state.muniCode);
    const v = presetValue(row, p, state.caseId);
    if (p === 'case' && v === null) { applyPreset('max_2025'); return; } // ケース値が無い市区町村は最大値へ
    if (p !== 'manual' && v === null) { state.preset = 'manual'; return; }
    state.preset = p;
    if (v !== null) state.heightM = clampHeight(v);
  }

  function emit() {
    syncUrl();
    cb.onChange(getState());
  }

  function getState(): UiState { return { ...state }; }

  // ---- 市区町村セレクタ --------------------------------------------------------
  function buildPrefOptions() {
    prefSelect.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = prefCodes.length ? 'すべての都道府県' : '都道府県データなし';
    prefSelect.appendChild(all);
    for (const code of prefCodes) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = prefNames.get(code) ?? code;
      prefSelect.appendChild(o);
    }
    prefSelect.disabled = prefCodes.length === 0;
  }

  function filteredMunis(): Municipality[] {
    const pref = prefSelect.value;
    const q = norm(muniSearch.value);
    return munis.filter((m) => {
      if (pref && m.pref_code !== pref) return false;
      if (!q) return true;
      return norm(m.name).includes(q) || norm(m.pref).includes(q) || m.code.startsWith(q);
    });
  }

  function buildMuniOptions() {
    const list = filteredMunis();
    muniSelect.replaceChildren();
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = munis.length === 0
      ? '市区町村データなし'
      : list.length === 0 ? '該当する市区町村がありません' : '市区町村を選択…';
    muniSelect.appendChild(ph);

    const grouped = !prefSelect.value; // 全国表示時は都道府県ごとにグループ化
    let container: HTMLElement = muniSelect;
    let currentPref = '';
    for (const m of list) {
      if (grouped && m.pref_code !== currentPref) {
        currentPref = m.pref_code;
        const g = document.createElement('optgroup');
        g.label = prefNames.get(m.pref_code) ?? m.pref;
        muniSelect.appendChild(g);
        container = g;
      }
      const o = document.createElement('option');
      o.value = m.code;
      o.textContent = grouped ? m.name : m.name;
      if (m.nankai_target) o.dataset.nankai = '1';
      container.appendChild(o);
    }
    muniSelect.disabled = list.length === 0;
    muniSelect.value = state.muniCode && list.some((m) => m.code === state.muniCode) ? state.muniCode : '';
    muniCount.textContent = munis.length ? `${list.length} / ${munis.length} 件` : '';
    flyToBtn.disabled = !state.muniCode;
  }

  function renderTsunamiTable() {
    const m = state.muniCode ? muniByCode.get(state.muniCode) : undefined;
    const row = findRow(state.muniCode);
    if (!m) {
      tsName.textContent = '市区町村を選択してください';
      tsMax2025.textContent = tsMean2025.textContent = tsMax2012.textContent = tsArea.textContent = '—';
      tsNote.textContent = rows.length ? '' : '津波高データ（内閣府一覧表）が読み込まれていません。手動スライダーで高さを指定できます。';
      tsNote.hidden = !tsNote.textContent;
      return;
    }
    tsName.textContent = `${m.pref} ${m.name}${m.nankai_target ? '' : '（内閣府一覧表に掲載なし）'}`;
    tsMax2025.textContent = fmtM(row?.max_2025);
    tsMean2025.textContent = fmtM(row?.mean_2025);
    tsMax2012.textContent = fmtM(row?.max_2012);
    tsArea.textContent = fmtHa(row?.area_ha_2025);
    const notes: string[] = [];
    if (!row) notes.push('この市区町村の津波高データはありません（手動スライダーで指定してください）。');
    else if (row.note) notes.push(row.note);
    if (row && row.raw_name && row.raw_name !== m.name) notes.push(`一覧表の表記: ${row.raw_name}`);
    tsNote.textContent = notes.join(' ');
    tsNote.hidden = notes.length === 0;
  }

  // ---- プリセット --------------------------------------------------------------
  const presetButtons = new Map<Preset, { btn: HTMLButtonElement; val: HTMLElement }>();
  function buildPresets() {
    presetsEl.replaceChildren();
    for (const p of PRESET_ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.dataset.preset = p;
      const val = document.createElement('b');
      const label = document.createElement('span');
      label.textContent = PRESET_LABEL[p];
      b.append(val, label);
      b.addEventListener('click', () => {
        if (p === 'manual') { state.preset = 'manual'; }
        else if (p === 'case' && !state.caseId) { caseSelect.focus(); return; } // ケース未選択なら選択欄へ誘導
        else {
          const v = presetValue(findRow(state.muniCode), p, state.caseId);
          if (v === null) return; // データなし（disabled のはず）
          state.preset = p;
          state.heightM = clampHeight(v);
        }
        render();
        emit();
      });
      presetsEl.appendChild(b);
      presetButtons.set(p, { btn: b, val });
    }
  }

  function renderPresets() {
    const row = findRow(state.muniCode);
    for (const p of PRESET_ORDER) {
      const { btn, val } = presetButtons.get(p)!;
      if (p === 'manual') {
        val.textContent = `${state.heightM.toFixed(1)} m`;
        btn.disabled = false;
        btn.setAttribute('aria-label', `手動 ${state.heightM.toFixed(1)} m`);
      } else if (p === 'case' && !state.caseId) {
        val.textContent = 'ケース未選択';
        btn.disabled = false;
        btn.setAttribute('aria-label', 'ケース別（上で津波ケースを選択してください）');
      } else {
        const v = presetValue(row, p, state.caseId);
        val.textContent = v === null ? 'データなし' : `${v.toFixed(1)} m`;
        btn.disabled = v === null;
        btn.setAttribute('aria-label', `${PRESET_LABEL[p]} ${v === null ? 'データなし' : `${v.toFixed(1)} m`}`);
      }
      const active = state.preset === p;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  // ---- 描画 ----------------------------------------------------------------------
  function renderControls() {
    slider.value = state.heightM.toFixed(1);
    heightReadout.textContent = `${state.heightM.toFixed(1)} m`;
    slider.setAttribute('aria-valuetext', `${state.heightM.toFixed(1)} メートル`);
    officialToggle.checked = state.showOfficial;
    legend.hidden = !state.showOfficial;
    bldgToggle.checked = state.showBuildings;
    lod2Toggle.checked = state.lod2;
    lod2Toggle.disabled = !state.showBuildings;
    imageryPale.checked = state.imagery === 'pale';
    imageryPhoto.checked = state.imagery === 'photo';
    waterToggle.checked = state.showWater;
    if (qualitySelect.value !== state.quality) qualitySelect.value = state.quality;
  }

  function render() {
    // 都道府県セレクタは選択中の市区町村に追従（検索で他県を選んだ場合など）
    const m = state.muniCode ? muniByCode.get(state.muniCode) : undefined;
    if (m && prefSelect.value && prefSelect.value !== m.pref_code) prefSelect.value = m.pref_code;
    buildMuniOptions();
    renderTsunamiTable();
    renderPresets();
    renderControls();
    renderCase();
    renderIntensity();
  }

  // ---- 津波ケース（内閣府 ①〜⑪＝大すべり域の位置） ---------------------------------
  function buildCaseOptions() {
    caseSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '指定なし（全ケースの最大値で表示）';
    caseSelect.appendChild(none);
    for (const c of TSUNAMI_CASES) {
      const o = document.createElement('option');
      o.value = c.id;
      const tag = c.branchFault ? '・分岐断層あり' : c.slipCount === 2 ? '・2箇所' : '';
      o.textContent = `${c.label} ${c.regions}${tag}`;
      caseSelect.appendChild(o);
    }
    caseSelect.disabled = TSUNAMI_CASES.length === 0;
  }

  function renderCase() {
    const c = findCase(state.caseId);
    if (caseSelect.value !== (c ? c.id : '')) caseSelect.value = c ? c.id : '';
    caseMapLegend.hidden = !c;
    if (!c) {
      caseDesc.textContent = '指定なしのときは、各市区町村の「①〜⑪の最大値」（2025 一覧表の最大値）を使います。';
      return;
    }
    const parts = [`${c.label}: 大すべり域・超大すべり域を「${c.regions}」に設定`];
    if (c.branchFault) parts.push('熊野灘の分岐断層が動く想定');
    if (c.slipCount === 2) parts.push('大すべり域を2箇所に設定');
    if (c.note) parts.push(c.note);
    const m = state.muniCode ? muniByCode.get(state.muniCode) : undefined;
    if (m) {
      const row = findRow(state.muniCode);
      const v = presetValue(row, 'case', state.caseId);
      const max = presetValue(row, 'max_2025');
      parts.push(v === null
        ? `${m.name}: このケースの公表値はありません`
        : `${m.name}: このケースの最大津波高 ${v.toFixed(1)} m` + (max !== null ? `（全ケース最大 ${max.toFixed(1)} m）` : ''));
    } else {
      parts.push('市区町村を選ぶと、そのケースの市町村別最大津波高（公表値）を表示・反映します');
    }
    caseDesc.textContent = parts.join('。') + '。';
  }

  caseSelect.addEventListener('change', () => {
    const next = findCase(caseSelect.value)?.id ?? null;
    state.caseId = next;
    if (next) applyPreset('case');
    else if (state.preset === 'case') applyPreset('max_2025');
    render();
    emit();
  });
  caseFit.addEventListener('click', () => cb.onFitCase?.());

  // ---- 震度（参考表示。地図には影響しない） ------------------------------------------
  function buildIntensityOptions() {
    intensitySelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '選択なし';
    intensitySelect.appendChild(none);
    for (const lv of JMA_INTENSITY) {
      const o = document.createElement('option');
      o.value = lv.key;
      o.textContent = lv.label;
      intensitySelect.appendChild(o);
    }
    intensitySelect.disabled = JMA_INTENSITY.length === 0;
  }

  function renderIntensity() {
    const lv = findIntensity(state.intensity);
    if (intensitySelect.value !== (lv ? lv.key : '')) intensitySelect.value = lv ? lv.key : '';
    intensityDesc.replaceChildren();
    intensityDesc.hidden = !lv;
    if (!lv) return;
    const head = document.createElement('div');
    head.className = 'intensity-head';
    head.textContent = `${lv.label}（気象庁 震度階級関連解説表より）`;
    const dl = document.createElement('dl');
    for (const [k, v] of [['人の体感・行動', lv.people], ['屋内の状況', lv.indoor], ['屋外の状況', lv.outdoor]]) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    }
    intensityDesc.append(head, dl);
  }

  intensitySelect.addEventListener('change', () => {
    state.intensity = findIntensity(intensitySelect.value)?.key ?? null;
    renderIntensity();
    emit();
  });

  // ---- イベント ------------------------------------------------------------------
  prefSelect.addEventListener('change', () => { buildMuniOptions(); });
  muniSearch.addEventListener('input', () => { buildMuniOptions(); });
  muniSearch.addEventListener('keydown', (ev) => {
    // Enter で検索結果が1件ならそのまま選択
    if (ev.key !== 'Enter') return;
    const list = filteredMunis();
    if (list.length === 1) { ev.preventDefault(); selectMuni(list[0].code); }
  });
  muniSelect.addEventListener('change', () => {
    const code = muniSelect.value || null;
    if (code === state.muniCode) return;
    selectMuni(code);
  });
  flyToBtn.addEventListener('click', () => { if (state.muniCode) cb.onFlyTo(state.muniCode); });

  function selectMuni(code: string | null) {
    state.muniCode = normalizeCode(code);
    // 選択時は 2025 最大 を既定プリセットにする（値が無ければ手動のまま）
    if (state.muniCode) applyPreset('max_2025');
    render();
    emit();
  }

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    if (!Number.isFinite(v)) return;
    state.heightM = clampHeight(v);
    state.preset = 'manual';
    heightReadout.textContent = `${state.heightM.toFixed(1)} m`;
    renderPresets();
    emit();
  });

  officialToggle.addEventListener('change', () => { state.showOfficial = officialToggle.checked; legend.hidden = !state.showOfficial; emit(); });
  bldgToggle.addEventListener('change', () => { state.showBuildings = bldgToggle.checked; lod2Toggle.disabled = !state.showBuildings; emit(); });
  lod2Toggle.addEventListener('change', () => { state.lod2 = lod2Toggle.checked; emit(); });
  imageryPale.addEventListener('change', () => { if (imageryPale.checked) { state.imagery = 'pale'; emit(); } });
  imageryPhoto.addEventListener('change', () => { if (imageryPhoto.checked) { state.imagery = 'photo'; emit(); } });
  waterToggle.addEventListener('change', () => { state.showWater = waterToggle.checked; emit(); });
  qualitySelect.addEventListener('change', () => {
    const q = qualitySelect.value as Quality;
    state.quality = ['auto', 'high', 'standard', 'lite'].includes(q) ? q : 'auto';
    try { localStorage.setItem(QUALITY_STORAGE_KEY, state.quality); } catch { /* private mode 等 */ }
    emit();
  });
  resetViewBtn.addEventListener('click', () => cb.onResetView());

  bannerEl.addEventListener('click', () => { bannerEl.hidden = true; });

  // ---- 操作方法モーダル（開閉・Esc・背景クリック・フォーカストラップ） ----
  const helpBtn = $<HTMLButtonElement>('helpBtn');
  const helpModal = $<HTMLElement>('helpModal');
  const helpClose = $<HTMLButtonElement>('helpClose');
  let helpReturnFocus: HTMLElement | null = null;
  function focusablesIn(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((el) => el.offsetParent !== null);
  }
  function setHelpOpen(open: boolean) {
    if (open === !helpModal.hidden) return;
    helpModal.hidden = !open;
    helpBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      helpReturnFocus = (document.activeElement as HTMLElement | null) ?? helpBtn;
      helpClose.focus();
    } else {
      (helpReturnFocus ?? helpBtn).focus();
      helpReturnFocus = null;
    }
  }
  helpBtn.addEventListener('click', () => setHelpOpen(helpModal.hidden));
  helpClose.addEventListener('click', () => setHelpOpen(false));
  helpModal.addEventListener('click', (ev) => { if (ev.target === helpModal) setHelpOpen(false); });
  helpModal.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); setHelpOpen(false); return; }
    if (ev.key !== 'Tab') return;
    const items = focusablesIn(helpModal);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !helpModal.hidden) setHelpOpen(false); });
  readoutEl.addEventListener('click', () => { readoutEl.hidden = true; });

  function setPanelOpen(open: boolean) {
    panel.hidden = !open;
    panelToggle.textContent = open ? '▼ パネルを閉じる' : '▲ パネルを開く';
    panelToggle.classList.toggle('collapsed', !open);
    panelToggle.setAttribute('aria-expanded', String(open));
    // 震源域の地図凡例はパネル（スマホでは下部シート）の直上に置く。閉じたら画面下端へ寄せる
    document.getElementById('slipLegend')?.classList.toggle('panel-collapsed', !open);
  }
  panelToggle.addEventListener('click', () => setPanelOpen(panel.hidden));

  // ---- 初期化 --------------------------------------------------------------------
  buildPrefOptions();
  buildPresets();
  buildCaseOptions();
  buildIntensityOptions();

  try {
    const saved = localStorage.getItem(QUALITY_STORAGE_KEY);
    if (saved && ['auto', 'high', 'standard', 'lite'].includes(saved)) state.quality = saved as Quality;
  } catch { /* ignore */ }
  const fromUrl = readUrl();
  applyPartial(fromUrl);
  applyPartial(initial);
  const heightExplicit = typeof initial.heightM === 'number' || typeof fromUrl.heightM === 'number';
  if (state.muniCode && !heightExplicit) {
    applyPreset(state.preset === 'manual' ? 'max_2025' : state.preset);
  } else if (state.muniCode && heightExplicit && !initial.preset) {
    // 明示的な高さがプリセット値と一致すればそのプリセットを点灯、そうでなければ手動
    const row = findRow(state.muniCode);
    const hit = PRESET_ORDER.find((p) => p !== 'manual' && presetValue(row, p, state.caseId) === state.heightM);
    state.preset = hit ?? 'manual';
  } else if (!state.muniCode && !initial.preset) {
    state.preset = 'manual';
  }
  const m0 = state.muniCode ? muniByCode.get(state.muniCode) : undefined;
  if (m0) prefSelect.value = m0.pref_code;
  render();
  setPanelOpen(true);
  syncUrl();

  // ---- ハンドル ------------------------------------------------------------------
  return {
    getState,
    setState(p) {
      applyPartial(p);
      if (p.preset && p.preset !== 'manual' && typeof p.heightM !== 'number') applyPreset(p.preset);
      render();
      syncUrl();
    },
    setStatus(text) {
      statusEl.textContent = text ?? '';
      statusEl.hidden = !text;
    },
    setBanner(msg, level = 'warn') {
      if (!msg) { bannerEl.hidden = true; bannerEl.textContent = ''; return; }
      bannerEl.textContent = msg;
      bannerEl.className = `banner ${level}`;
      bannerEl.title = 'タップで閉じる';
      bannerEl.hidden = false;
    },
    setQualityNote(text) { qualityNote.textContent = text ?? ''; },
    setReadout(text) {
      if (text === null || text === '') { readoutEl.hidden = true; readoutEl.replaceChildren(); return; }
      readoutHint.hidden = true;
      const lines = String(text).split('\n');
      readoutEl.replaceChildren();
      lines.forEach((line, i) => {
        const el = document.createElement(i === 0 ? 'b' : 'span');
        el.textContent = line;
        if (i === 0) el.className = /浸水なし|なし|できません/.test(line) ? 'dry' : 'wet';
        readoutEl.appendChild(el);
      });
      readoutEl.hidden = false;
    },
  };
}
