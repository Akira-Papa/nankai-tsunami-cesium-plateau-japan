import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { TERRAIN_URL, GSI_PALE, GSI_PHOTO } from './tilesets';
import { loadAll, loadCoastalPref, findMunicipality, findTsunamiRow, tsunamiHeight, type AppData, type Municipality, type PlateauTileset, type BBox } from './data';
import { detectQuality, applySceneQuality, QUALITY_PROFILES, type QualityLevel, type QualityProfile } from './quality';
import { findCase, findIntensity } from './scenarios';
import { createSlipOverlay, type SlipOverlay } from './slipRegions';
import { initGeoid, geoidHeight, geoidSource, sanityCheckGeoid, GEOID_CREDIT_HTML } from './geoid';
import { createWaterLayer, type WaterLayer } from './water';
import { initUi, type UiState, type UiHandle } from './ui';
import { createTilesetManager, type TilesetManager, type PlateauRegistry as TmRegistry, type PlateauTilesetEntry as TmEntry } from './tilesetManager';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
/** 初期視点（市区町村未選択時）: 南海トラフ沿岸を俯瞰 */
const JAPAN_OVERVIEW = { lon: 135.5, lat: 33.6, height: 900_000 };
/** 公式想定レイヤ（重ねるハザードマップ 津波浸水想定 統合タイル）DATA_CONTRACT §6 */
const OFFICIAL_TSUNAMI_URL = 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png';
const OFFICIAL_ALPHA = 0.6;
const DISCLAIMER =
  '簡易可視化であり公式想定ではありません。内閣府の津波高は海岸線での最大値で、内陸へ一律に適用すると過大・過小になります。避難判断は各自治体のハザードマップを参照してください';
// ---- 表示品質（端末に応じて自動判定。UI の「表示品質」で上書き・保存） ----
const detected = detectQuality();
let quality: QualityProfile = QUALITY_PROFILES[detected.level];
let tilesetsUpdateTimer = 0;

// ---------------------------------------------------------------------------
// 外部由来エラーのフィルタ（ブラウザ拡張など）
// ---------------------------------------------------------------------------
const EXTERNAL_ERROR_RE =
  /Receiving end does not exist|Could not establish connection|Extension context invalidated|message port closed|chrome-extension:|moz-extension:|safari-extension:|ResizeObserver loop/i;
export function isExternalError(message: string, source?: string | null, stack?: string | null): boolean {
  if (source && /^(chrome|moz|safari)-extension:/.test(source)) return true;
  if (stack && /(chrome|moz|safari)-extension:\/\//.test(stack)) return true;
  return EXTERNAL_ERROR_RE.test(message);
}

/** UI 初期化前でも使えるバナー（UI 準備後は ui.setBanner に委譲） */
let ui: UiHandle | undefined;
function showBanner(msg: string | null, level: 'warn' | 'error' = 'warn') {
  if (ui) { ui.setBanner(msg, level); return; }
  const el = document.getElementById('banner');
  if (!el) { if (msg) console.warn('[banner]', msg); return; }
  el.textContent = msg ?? '';
  el.className = `banner ${level}`;
  el.hidden = !msg;
}

window.addEventListener('error', (ev) => {
  const msg = String(ev.message ?? '');
  const stack = (ev.error as { stack?: string } | undefined)?.stack ?? null;
  if (isExternalError(msg, ev.filename, stack) || /^Script error\.?$/.test(msg)) {
    console.debug('[外部由来のエラーを無視]', msg);
    return;
  }
  console.error(ev.error ?? ev.message);
  showBanner(`エラーが発生しました: ${msg}`, 'error');
});
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason as { message?: string; stack?: string } | undefined;
  const msg = String(reason?.message ?? ev.reason ?? '');
  if (isExternalError(msg, null, reason?.stack ?? null)) {
    console.debug('[外部由来の拒否を無視]', msg);
    ev.preventDefault();
    return;
  }
  console.error(ev.reason);
  showBanner(`処理に失敗しました: ${msg}`, 'error');
});

// ---------------------------------------------------------------------------
// Viewer（Cesium ion 不使用・モバイル設定は名古屋版を踏襲）
// ---------------------------------------------------------------------------
Cesium.Ion.defaultAccessToken = '';

function makeGsiLayer(kind: 'pale' | 'photo') {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: kind === 'pale' ? GSI_PALE : GSI_PHOTO,
    maximumLevel: 18,
    credit: new Cesium.Credit('<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>', true),
  });
  return new Cesium.ImageryLayer(provider);
}

function makeOfficialLayer() {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: OFFICIAL_TSUNAMI_URL,
    minimumLevel: 2,
    maximumLevel: 17,
    credit: new Cesium.Credit('<a href="https://disaportal.gsi.go.jp/" target="_blank">ハザードマップポータルサイト</a>', true),
  });
  const layer = new Cesium.ImageryLayer(provider, { alpha: OFFICIAL_ALPHA, show: false });
  provider.errorEvent.addEventListener(() => { /* 範囲外タイルの 404 は正常。黙って無視 */ });
  return layer;
}

function createViewer(): Cesium.Viewer {
  try {
    return new Cesium.Viewer('cesiumContainer', {
      baseLayer: makeGsiLayer('pale'),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      shadows: false,
      msaaSamples: 1,
      useBrowserRecommendedResolution: false,
    });
  } catch (e) {
    console.error('[Viewer] 初期化に失敗:', e);
    showBanner('3D表示を初期化できませんでした。WebGL に対応したブラウザでお試しください。', 'error');
    throw e;
  }
}

const viewer = createViewer();
const scene = viewer.scene;
// 描画停止（Cesium の renderError）は黙らせず、原因をコンソールとバナーに出す
scene.renderError.addEventListener((_s: unknown, err: unknown) => {
  console.error('[Cesium renderError]', err);
  showBanner(`3D描画でエラーが発生しました: ${String((err as Error)?.message ?? err)}。ページを再読み込みしてください。`, 'error');
});
scene.globe.depthTestAgainstTerrain = true;
scene.shadowMap.enabled = false;
applySceneQuality(viewer, quality);
scene.globe.enableLighting = false;
scene.screenSpaceCameraController.minimumZoomDistance = 30;
viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

viewer.creditDisplay.addStaticCredit(new Cesium.Credit('PLATEAU（国土交通省）｜内閣府 南海トラフ巨大地震モデル検討会｜国土地理院', true));
viewer.creditDisplay.addStaticCredit(new Cesium.Credit(GEOID_CREDIT_HTML, true));

const officialLayer = makeOfficialLayer();
viewer.imageryLayers.add(officialLayer);

const requestRender = () => scene.requestRender();

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
const state = {
  terrainOk: false,
  /** 3D Tiles の水没着色に使う代表点（選択市区町村の代表点。未選択時は視野中心） */
  lastPick: undefined as { lon: number; lat: number; ellipsoidH: number } | undefined,
};

let data: AppData | undefined;
let water: WaterLayer | undefined;
let tilesets: TilesetManager | undefined;
let slip: SlipOverlay | undefined;
let uiState: UiState = {
  muniCode: null, heightM: 5.0, preset: 'max_2025', caseId: null, intensity: null, showOfficial: false, showBuildings: true, lod2: false, imagery: 'pale', showWater: true, quality: 'auto',
};

/** 都道府県ごとの範囲（沿岸・対象市区町村の bbox の和）。県別ポリゴンの遅延読込判定に使う */
function prefBBoxes(d: AppData): Record<string, BBox> {
  const out: Record<string, BBox> = {};
  for (const m of d.municipalities.municipalities) {
    if (!(m.coastal || m.nankai_target)) continue;
    const b = out[m.pref_code];
    out[m.pref_code] = b
      ? [Math.min(b[0], m.bbox[0]), Math.min(b[1], m.bbox[1]), Math.max(b[2], m.bbox[2]), Math.max(b[3], m.bbox[3])]
      : [...m.bbox] as BBox;
  }
  return out;
}

function effectiveQualityLevel(sel: UiState['quality']): QualityLevel {
  return sel === 'auto' ? detected.level : sel;
}

/** 品質を切り替え、建物・水面レイヤを新しい上限で作り直す */
function rebuildForQuality(level: QualityLevel) {
  quality = QUALITY_PROFILES[level];
  applySceneQuality(viewer, quality);
  if (data) {
    tilesets?.dispose();
    tilesets = undefined;
    try {
      tilesets = createTilesetManager(viewer, {
        registry: toTmRegistry(data.registry),
        maxConcurrent: quality.tilesetMaxConcurrent,
        maxLoaded: quality.tilesetMaxLoaded,
        maxCameraHeight: quality.tilesetMaxCameraHeight,
        mobile: quality.tilesetMobileProfile,
        lod2: uiState.lod2,
        onStatus: () => updateStatus(),
      });
      tilesets.setEnabled(uiState.showBuildings);
    } catch (e) { console.warn('[建物] 再構成に失敗:', e); }
    water?.dispose();
    water = createWaterLayer(viewer, {
      geojson: data.coastal,
      tsunami: data.tsunami,
      geoidFn: geoidHeight,
      maxEntities: quality.waterMaxEntities,
      prefBBoxes: prefBBoxes(data),
      loadPref: (code) => loadCoastalPref(code),
      onStatus: () => updateStatus(),
    });
    water.setState({ muniCode: uiState.muniCode, heightM: uiState.heightM, preset: uiState.preset, caseId: uiState.caseId, show: uiState.showWater });
    water.refresh(true);
    scheduleTilesetUpdate(300);
  }
  ui?.setQualityNote?.(`${quality.label}（自動判定: ${QUALITY_PROFILES[detected.level].label}／${detected.reasons.join('・')}）`);
  updateStatus();
  requestRender();
}

/** 建物 3D Tiles の読込判定は視点が落ち着いてから（連続操作中に全国分の要求を出さない） */
function scheduleTilesetUpdate(delayMs = 450) {
  window.clearTimeout(tilesetsUpdateTimer);
  tilesetsUpdateTimer = window.setTimeout(() => { tilesets?.update(); updateStatus(); }, delayMs);
}

// ---------------------------------------------------------------------------
// 視点
// ---------------------------------------------------------------------------
function flyToMunicipality(m: Municipality, duration = 1.6) {
  const [w, s, e, n] = m.bbox;
  const center = Cesium.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0);
  const meterPerDegLat = 111_320;
  const meterPerDegLon = 111_320 * Math.cos(Cesium.Math.toRadians((s + n) / 2));
  const radius = Math.max(1500, Math.hypot((e - w) * meterPerDegLon, (n - s) * meterPerDegLat) / 2);
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, radius), {
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), radius * 2.0),
    duration,
  });
}

/**
 * 震源域（概略）と選択中の市区町村が一画面に入る画角へ移動。
 * PC は左の操作パネル（--panel-w）、スマホは下部シート（--sheet-h）を避けるため、範囲をその方向へ広げてから flyTo する。
 */
function fitCaseAndMunicipality(duration = 1.2) {
  const bb = slip?.bbox();
  if (!bb) return;
  let [w, s, e, n] = bb;
  const m = data ? findMunicipality(data.municipalities, uiState.muniCode) : undefined;
  if (m) { w = Math.min(w, m.bbox[0]); s = Math.min(s, m.bbox[1]); e = Math.max(e, m.bbox[2]); n = Math.max(n, m.bbox[3]); }
  // 余白 8%
  const pw = (e - w) * 0.08, ph = (n - s) * 0.08;
  w -= pw; e += pw; s -= ph; n += ph;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (vw > 640) {
    // 左パネル分だけ西側へ広げる（パネル幅 380px + 余白）
    const frac = Math.min(0.6, (400) / vw);
    w -= (e - w) * (frac / (1 - frac));
  } else {
    // 下部シート分だけ南側へ広げる（シートを閉じているときは凡例ぶんだけ）
    const panelOpen = !(document.getElementById('panel')?.hidden ?? false);
    const frac = Math.min(0.6, (panelOpen ? vh * 0.58 + 60 : 110) / vh);
    s -= (n - s) * (frac / (1 - frac));
  }
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(w, s, e, n),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration,
  });
  pumpRender(duration);
}

/** requestRenderMode 下でカメラ飛行や地形クランプ描画を進めるため、一定時間フレーム描画を要求し続ける */
function pumpRender(seconds: number) {
  const end = performance.now() + seconds * 1000 + 300;
  const step = () => {
    scene.requestRender();
    if (performance.now() < end) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function resetView() {
  const m = data ? findMunicipality(data.municipalities, uiState.muniCode) : undefined;
  if (m) { flyToMunicipality(m, 1.0); return; }
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(JAPAN_OVERVIEW.lon, JAPAN_OVERVIEW.lat, JAPAN_OVERVIEW.height),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
    duration: 1.0,
  });
}

// ---------------------------------------------------------------------------
// 地形（PLATEAU-Terrain）
// ---------------------------------------------------------------------------
async function setupTerrain(): Promise<boolean> {
  try {
    const terrain = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL, {
      requestVertexNormals: quality.terrainVertexNormals,
      credit: new Cesium.Credit('PLATEAU | Mapterhorn | 国土地理院', false),
    });
    viewer.terrainProvider = terrain;
    state.terrainOk = true;
    requestRender();
    return true;
  } catch (e) {
    console.warn('[地形] PLATEAU-Terrain の読込に失敗。楕円体地形にフォールバックします:', e);
    showBanner('地形データ（PLATEAU-Terrain）を読み込めませんでした。平坦な楕円体地形で表示しています（標高は反映されません）。', 'error');
    return false;
  }
}

// ---------------------------------------------------------------------------
// タップ計測（T.P. 標高と浸水深）
// ---------------------------------------------------------------------------
const pickMarker = viewer.entities.add({
  name: '計測地点',
  show: false,
  point: {
    pixelSize: 12,
    color: Cesium.Color.fromCssColorString('#ffb454'),
    outlineColor: Cesium.Color.fromCssColorString('#222'),
    outlineWidth: 2,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  },
});

function fmtSigned(v: number) { return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`; }

function refreshReadout() {
  const p = state.lastPick;
  if (!p || !ui) return;
  const geoid = geoidHeight(p.lon, p.lat);
  const groundTp = p.ellipsoidH - geoid;
  const tp = uiState.heightM;
  const depth = tp - groundTp;
  const pos = `${p.lat.toFixed(4)}N ${p.lon.toFixed(4)}E（ジオイド ${geoid.toFixed(2)} m）`;
  ui.setReadout(depth > 0
    ? `浸水 ${depth.toFixed(2)} m｜地盤 T.P. ${fmtSigned(groundTp)} m／水位 T.P. ${tp.toFixed(1)} m｜${pos}`
    : `浸水なし｜地盤 T.P. ${fmtSigned(groundTp)} m（水面より ${(-depth).toFixed(2)} m 高い）｜${pos}`);
}

function pickGround(windowPos: Cesium.Cartesian2) {
  if (!ui) return;
  if (!state.terrainOk) {
    ui.setReadout('地形データなし: PLATEAU-Terrain を読み込めていないため標高を計測できません');
    return;
  }
  const ray = scene.camera.getPickRay(windowPos);
  const cart = ray ? scene.globe.pick(ray, scene) : undefined;
  if (!cart) {
    ui.setReadout('計測できません: 地形の上をタップしてください（地形タイル読込中の可能性あり）');
    return;
  }
  const c = Cesium.Cartographic.fromCartesian(cart);
  if (!c || !Number.isFinite(c.height)) return;
  state.lastPick = { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), ellipsoidH: c.height };
  pickMarker.position = new Cesium.ConstantPositionProperty(cart);
  pickMarker.show = true;
  refreshReadout();
  requestRender();
}

const pickHandler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
pickHandler.setInputAction((ev: Cesium.ScreenSpaceEventHandler.PositionedEvent) => pickGround(ev.position), Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---------------------------------------------------------------------------
// 状態の適用
// ---------------------------------------------------------------------------
function viewCenterLonLat(): { lon: number; lat: number } {
  const r = viewer.camera.computeViewRectangle(Cesium.Ellipsoid.WGS84);
  if (r) return { lon: Cesium.Math.toDegrees((r.west + r.east) / 2), lat: Cesium.Math.toDegrees((r.south + r.north) / 2) };
  const c = viewer.camera.positionCartographic;
  return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
}

/** 建物シェーダの水位を更新（選択市区町村の代表点、未選択時は視野中心のジオイドを基準） */
function pushWaterLevelToBuildings() {
  if (!tilesets) return;
  const m = data ? findMunicipality(data.municipalities, uiState.muniCode) : undefined;
  const ref = m ? { lon: m.lon, lat: m.lat } : viewCenterLonLat();
  const tp = uiState.heightM;
  tilesets.setWaterLevel(tp + geoidHeight(ref.lon, ref.lat), geoidHeight, tp);
}

function applyImagery(kind: 'pale' | 'photo') {
  const layers = viewer.imageryLayers;
  const base = layers.get(0);
  if (base) layers.remove(base, true);
  layers.add(makeGsiLayer(kind), 0);
  requestRender();
}

let prevState: UiState | undefined;
function applyState(s: UiState) {
  const prev = prevState;
  uiState = s;
  if (prev && effectiveQualityLevel(prev.quality) !== effectiveQualityLevel(s.quality)) rebuildForQuality(effectiveQualityLevel(s.quality));
  water?.setState({ muniCode: s.muniCode, heightM: s.heightM, preset: s.preset, caseId: s.caseId, show: s.showWater });
  // 震源域（大すべり域）の概略オーバーレイ: ケース選択中のみ。地図凡例も連動。ケースが変わったら一画面へ
  const c = findCase(s.caseId);
  if (slip && (!prev || prev.caseId !== s.caseId)) {
    slip.setRegions(c ? c.regionKeys : []);
    if (c && prev) fitCaseAndMunicipality();
    else pumpRender(1.5);
  }
  const slipLegend = document.getElementById('slipLegend');
  const slipLegendText = document.getElementById('slipLegendText');
  if (slipLegend) slipLegend.hidden = !c;
  if (slipLegendText && c) slipLegendText.textContent = `${c.label} ${c.regions}: 震源域（大すべり域・超大すべり域）の概略`;
  if (!prev || prev.imagery !== s.imagery) applyImagery(s.imagery);
  if (!prev || prev.showOfficial !== s.showOfficial) { officialLayer.show = s.showOfficial; requestRender(); }
  if (tilesets) {
    if (!prev || prev.showBuildings !== s.showBuildings) tilesets.setEnabled(s.showBuildings);
    if (!prev || prev.lod2 !== s.lod2) tilesets.setLod2(s.lod2);
  }
  pushWaterLevelToBuildings();
  refreshReadout();
  updateStatus();
  prevState = s;
  requestRender();
}

function updateStatus() {
  if (!ui) return;
  const parts: string[] = [];
  if (tilesets) { const st = tilesets.stats(); parts.push(`建物 ${st.loaded}${st.loading ? `（+${st.loading} 読込中）` : ''}`); }
  if (water) parts.push(`水面 ${water.visibleCodes().length} 市区町村`);
  const tc = findCase(uiState.caseId);
  if (tc) parts.push(`${tc.label} ${tc.regions}`);
  const lv = findIntensity(uiState.intensity);
  if (lv) parts.push(`参考: ${lv.label}（浸水表示には影響なし）`);
  parts.push(`品質: ${quality.label}`);
  parts.push(`ジオイド: ${geoidSource() === 'gsigeo2011' ? 'GSIGEO2011' : geoidSource() === 'terrain-estimate' ? '地形推定' : '既定値'}`);
  if (data?.isFixture) parts.push('FIXTURE');
  ui.setStatus(parts.join('｜'));
}

// ---------------------------------------------------------------------------
// UI（A3）。index.html が旧骨格のままで initUi が失敗した場合は、DOM を持たない最小ハンドルで継続する
// ---------------------------------------------------------------------------
function readUrlInitial(): Partial<UiState> {
  const q = new URLSearchParams(window.location.search);
  const out: Partial<UiState> = {};
  const m = q.get('m');
  if (m && /^\d{5}$/.test(m)) out.muniCode = m;
  const c = q.get('c');
  if (c && findCase(c)) { out.caseId = c; out.preset = 'case'; }
  const si = q.get('si');
  if (si && findIntensity(si)) out.intensity = si;
  const h = q.get('h');
  if (h !== null) {
    const v = parseFloat(h);
    if (Number.isFinite(v)) { out.heightM = Math.min(35, Math.max(0, Math.round(v * 10) / 10)); out.preset = 'manual'; }
  }
  return out;
}

function headlessUi(initial: Partial<UiState>, onChange: (s: UiState) => void): UiHandle {
  const st: UiState = { ...uiState, ...initial };
  console.warn('[UI] initUi が失敗したため、DOM なしの最小 UI ハンドルで継続します（index.html の更新待ち）');
  return {
    setState(p) { Object.assign(st, p); onChange({ ...st }); },
    setStatus(t) { console.info('[status]', t); },
    setBanner(msg, level) { if (msg) console.warn(`[banner:${level ?? 'warn'}]`, msg); },
    setReadout(t) { if (t) console.info('[readout]', t); },
    getState: () => ({ ...st }),
  };
}

function toTmRegistry(r: AppData['registry']): TmRegistry {
  const isLod12 = (t: PlateauTileset): t is PlateauTileset & { lod: 1 | 2 } => t.lod === 1 || t.lod === 2;
  const tilesetsOk: TmEntry[] = r.tilesets.filter(isLod12).map((t) => ({ ...t, http_status: t.http_status ?? undefined }));
  return { generated: r.generated, source: r.source, tilesets: tilesetsOk };
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
(async () => {
  // 1. データ
  try {
    data = await loadAll();
  } catch (e) {
    console.error('[data]', e);
    showBanner(`データを読み込めませんでした: ${(e as Error).message}`, 'error');
    return;
  }
  const initial = readUrlInitial();
  const initialMuni = findMunicipality(data.municipalities, initial.muniCode);
  if (initial.muniCode && !initialMuni) { console.warn('[URL] 未知の市区町村コード:', initial.muniCode); initial.muniCode = undefined; }
  else if (initialMuni) initial.muniCode = initialMuni.code;
  if (initial.heightM === undefined) {
    const row = findTsunamiRow(data.tsunami, initial.muniCode);
    const cv = initial.caseId ? row?.cases_2025?.[initial.caseId] : null;
    const h = typeof cv === 'number' && Number.isFinite(cv) ? cv : tsunamiHeight(row, 'max_2025');
    if (h !== null) initial.heightM = h;
  }

  // 2. ジオイド（WASM）と地形は並列
  const [geoidOk] = await Promise.all([initGeoid(), setupTerrain()]);

  // 3. UI
  const callbacks = {
    onChange: (s: UiState) => applyState(s),
    onFlyTo: (code: string) => { const m = data && findMunicipality(data.municipalities, code); if (m) flyToMunicipality(m); },
    onResetView: () => resetView(),
    onFitCase: () => fitCaseAndMunicipality(),
  };
  try {
    ui = initUi({ municipalities: data.municipalities, tsunami: data.tsunami }, callbacks, initial);
  } catch (e) {
    console.warn('[UI] initUi 失敗:', e);
    ui = headlessUi(initial, callbacks.onChange);
  }
  const disclaimerEl = document.getElementById('disclaimer');
  if (disclaimerEl) disclaimerEl.textContent = DISCLAIMER;
  else ui.setBanner(DISCLAIMER, 'warn');
  if (!geoidOk) ui.setBanner('ジオイドモデル（japan-geoid）を初期化できませんでした。地形推定または既定値で水面高を計算します（誤差あり）。', 'warn');

  // 3b. 表示品質（保存済み／URL の指定があれば自動判定より優先）
  quality = QUALITY_PROFILES[effectiveQualityLevel(ui.getState().quality)];
  applySceneQuality(viewer, quality);
  ui.setQualityNote?.(`${quality.label}（自動判定: ${QUALITY_PROFILES[detected.level].label}／${detected.reasons.join('・')}）`);

  // 4. 建物（A2）
  try {
    tilesets = createTilesetManager(viewer, {
      registry: toTmRegistry(data.registry),
      maxConcurrent: quality.tilesetMaxConcurrent,
      maxLoaded: quality.tilesetMaxLoaded,
      maxCameraHeight: quality.tilesetMaxCameraHeight,
      mobile: quality.tilesetMobileProfile,
      lod2: ui.getState().lod2,
      onStatus: () => updateStatus(),
    });
  } catch (e) {
    console.warn('[建物] tilesetManager の初期化に失敗:', e);
    ui.setBanner('建物モデル管理を初期化できませんでした。水面のみ表示します。', 'warn');
  }

  // 5. 水面
  water = createWaterLayer(viewer, {
    geojson: data.coastal,
    tsunami: data.tsunami,
    geoidFn: geoidHeight,
    maxEntities: quality.waterMaxEntities,
    prefBBoxes: prefBBoxes(data),
    loadPref: (code) => loadCoastalPref(code),
    onStatus: () => updateStatus(),
  });

  // 5b. 震源域（大すべり域）の概略オーバーレイ
  slip = createSlipOverlay(viewer);

  // 6. 初期状態の適用と視点
  applyState(ui.getState());
  viewer.camera.moveEnd.addEventListener(() => {
    water?.refresh();
    pushWaterLevelToBuildings();
    updateStatus();
    scheduleTilesetUpdate();
  });
  if (initialMuni) flyToMunicipality(initialMuni, 0);
  else resetView();
  // flyTo(duration 0) 直後は moveEnd が来ない場合があるため明示的に 1 回更新
  window.setTimeout(() => { water?.refresh(true); pushWaterLevelToBuildings(); updateStatus(); requestRender(); }, 50);
  // 建物は地形・水面の初期読込を優先し、視点が落ち着いてから読み込む
  scheduleTilesetUpdate(1500);

  // 7. ジオイド健全性チェック（選択市区町村の代表点。未選択時は省略）
  if (initialMuni && state.terrainOk) {
    const r = await sanityCheckGeoid(viewer.terrainProvider, initialMuni.lon, initialMuni.lat);
    if (r.warn && r.diff !== null) {
      ui.setBanner(`ジオイド健全性チェック: ${initialMuni.name} 代表点で GSIGEO2011 と地形推定の差が ${Math.abs(r.diff).toFixed(2)} m あります（${r.message}）`, 'warn');
    }
    if (!geoidOk) { applyState(ui.getState()); }
    updateStatus();
  }
})().catch((e) => {
  console.error('[起動] 失敗:', e);
  showBanner('初期化中にエラーが発生しました。表示が不完全な可能性があります。', 'error');
});

window.addEventListener('resize', requestRender);
window.addEventListener('orientationchange', requestRender);

// デバッグ用
Object.assign(window as unknown as Record<string, unknown>, {
  viewer, Cesium,
  app: { get data() { return data; }, get water() { return water; }, get tilesets() { return tilesets; }, get ui() { return ui; }, get state() { return uiState; }, get slip() { return slip; }, viewer, geoidHeight, quality: () => quality.level, detected },
});
