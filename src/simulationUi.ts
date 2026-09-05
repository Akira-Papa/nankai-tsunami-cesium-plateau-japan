import type { SimulationConfig } from './simulationTypes';
import './simulationUi.css';
import { OCEAN_COLORS, LAND_COLORS } from './simulationLayer';

export interface SimulationUiCallbacks {
  onMode(active: boolean): void;
  onChange(config: SimulationConfig): void;
  onPick(): void;
  onInspect(): void;
  onFlyToSource?(): void;
  onRun(): void;
  onCancel(): void;
}

/** Programmatic setters deliberately do not emit user callbacks. */
export function initSimulationUi(container: HTMLElement, callbacks: SimulationUiCallbacks) {
  const root = document.createElement('section');
  root.className = 'simulation-ui';
  root.setAttribute('aria-label', '津波の計算方法');
  root.innerHTML = `
    <fieldset class="simulation-mode">
      <legend>津波の表示方法</legend>
      <label><input id="simulationModeOfficial" type="radio" name="simulationMode" value="official" checked><span>公式の計算済み</span></label>
      <label><input id="simulationModeCustom" type="radio" name="simulationMode" value="custom"><span>任意条件で計算</span></label>
    </fieldset>
    <div id="simulationControls" hidden>
      <div class="simulation-reference"><strong>海岸のピンク〜紫：公式の参考表示</strong><p id="simulationReferenceNote">内閣府2025の計算済み浸水を重ねています。ピンから再計算した結果とは別のデータです。</p><p>任意条件の計算結果は、海が青・陸が黄〜赤です。</p></div>
      <p class="simulation-notice">数kmメッシュの実験計算・実災害の予測ではありません</p>
      <div class="simulation-field">
        <label for="simulationHeight">波源の津波高（初期水面上昇）</label>
        <output id="simulationHeightOutput" for="simulationHeight">5.0 m</output>
        <input id="simulationHeight" type="range" min="0.1" max="50" step="0.1" value="5" aria-describedby="simulationHeightHelp">
        <div class="simulation-range"><span>0.1 m</span><span>50 m</span></div>
        <p id="simulationHeightHelp" class="simulation-help">沿岸到達高ではありません。波源で水面を持ち上げる高さです。</p>
      </div>
      <fieldset class="simulation-source">
        <legend>仮想波源（震源位置の代用）</legend>
        <label for="simulationSourcePreset">海域を選ぶ</label>
        <select id="simulationSourcePreset"><option value="custom">地図のピン・座標で指定</option><option value="noto">日本海：能登半島沖</option><option value="niigata">日本海：新潟沖</option><option value="akita">日本海：秋田沖</option><option value="hokkaido">日本海：北海道西方沖</option><option value="nankai">太平洋：四国沖</option></select>
        <p class="simulation-help">場所の例です。公式の地震・断層モデルではありません。</p>
        <button id="simulationPick" type="button" aria-pressed="false" aria-describedby="simulationPickHelp">📍 ピンを立てる</button>
        <button id="simulationInspect" type="button" aria-pressed="false">浸水深を調べる</button>
        <p id="simulationPickHelp" class="simulation-help">ボタンを押してから、地図の海上をクリックしてください。</p>
        <div class="simulation-coordinates">
          <label for="simulationLon">経度（東経）<input id="simulationLon" type="number" min="122" max="150" step="0.001" value="134" inputmode="decimal" required></label>
          <label for="simulationLat">緯度（北緯）<input id="simulationLat" type="number" min="24" max="46" step="0.001" value="32" inputmode="decimal" required></label>
        </div>
      </fieldset>
      <div class="simulation-field">
        <label for="simulationRadius">波源の広がり（半径 σ）</label>
        <output id="simulationRadiusOutput" for="simulationRadius">50 km</output>
        <input id="simulationRadius" type="range" min="20" max="100" step="5" value="50">
        <div class="simulation-range"><span>20 km</span><span>100 km</span></div>
      </div>
      <div class="simulation-field">
        <label for="simulationDuration">地震発生から計算する時間</label>
        <output id="simulationDurationOutput" for="simulationDuration">30 分</output>
        <input id="simulationDuration" type="range" min="5" max="120" step="5" value="30">
        <div class="simulation-range"><span>5 分</span><span>120 分</span></div>
      </div>
      <label class="simulation-domain-label" for="simulationDomain">計算範囲</label>
      <select id="simulationDomain" aria-describedby="simulationDomainHelp">
        <option value="national">日本周辺を広く（約8〜11 km）</option>
        <option value="regional">波源周辺を詳しく（約4〜6 km）</option>
      </select>
      <p id="simulationDomainHelp" class="simulation-help">東経122〜150°・北緯24〜46°。範囲外は未計算です。</p>
      <p class="simulation-help">設定を変えると自動で再計算します。色は指定時間までの最大値です。</p>
      <div class="simulation-actions">
        <button id="simulationRun" type="button">この条件で再計算</button>
        <button id="simulationCancel" type="button">中止</button>
      </div>
      <label class="simulation-progress-label" for="simulationProgress">計算の進捗 <output id="simulationProgressOutput">0%</output></label>
      <progress id="simulationProgress" max="100" value="0">0%</progress>
      <p id="simulationStatus" class="simulation-status" role="status" aria-live="polite"></p>
      <p id="simulationResult" class="simulation-result" aria-live="polite"></p>
      <div class="simulation-legend" aria-label="計算結果の色の意味">
        <p><i class="simulation-ocean-key"></i>海上：海面からの最大水位上昇</p>
        <p><i class="simulation-land-key"></i>陸上：地面からの最大浸水深</p>
        <div class="simulation-color-scale" aria-label="水位上昇と浸水深の色階級">${['0.01超','0.1–','0.3–','1–','3–','10–','20–','30–','50以上'].map((label,i)=>`<div><i style="background:${OCEAN_COLORS[i]}"></i><i style="background:${LAND_COLORS[i]}"></i><span>${label}</span></div>`).join('')}</div>
        <p class="simulation-help">単位 m。上段は海・下段は陸。0.01 m以下は透明。計算期間の最大値を示します。</p>
      </div>
      <details class="simulation-assumptions"><summary>計算の前提と解像度</summary>
        <p>海底・陸上の標高を使い、浅水方程式を計算します。ピンは断層の代わりに置く仮想の波源です。波源から海を通ってつながる範囲の初期水面を釣り鐘状に上昇させ、潮位は0 mとします。断層破壊・底面摩擦・堤防・潮汐は含まず、平面近似で計算します。</p>
        <p>数kmより小さい河川・堤防・建物・沿岸の低地は表現できません。建物単位の浸水や避難の判断には使えません。全国表示でも一部離島は計算範囲外です。地形は NOAA ETOPO1（平均海面基準）を間引いて使用しています。</p>
      </details>
    </div>`;
  container.append(root);
  // Keep the primary action above the height sliders and on the map itself.
  root.querySelector('.simulation-notice')!.after(root.querySelector('.simulation-source')!);
  const mapTools = document.createElement('div');
  mapTools.className = 'simulation-map-tools';
  mapTools.innerHTML = `<button id="simulationMapPick" type="button" aria-pressed="false">📍 ピンを立てる</button><p id="simulationMapPickHint">海上に波源を置いて、津波を計算</p>`;
  const loading = document.createElement('div');
  loading.className = 'simulation-loading'; loading.id = 'simulationLoading'; loading.hidden = true;
  loading.innerHTML = `<div class="simulation-loading-heading" role="status"><span class="simulation-spinner" aria-hidden="true"></span><strong>津波を計算中…</strong><button id="simulationMapCancel" type="button">中止</button></div><p id="simulationLoadingDetail"></p><progress id="simulationMapProgress" max="100" aria-label="津波計算の進捗"></progress><small>計算中も地図を操作できます</small>`;
  document.getElementById('mapMain')!.append(mapTools, loading);

  const node = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const input = (id: string) => node<HTMLInputElement>(id);
  let active = false;
  let config: SimulationConfig = { lon: 134, lat: 32, heightM: 5, radiusKm: 50, durationMinutes: 30, domain: 'national' };
  const status = node('simulationStatus');
  const setPicking = (picking: boolean) => {
    const pick = node<HTMLButtonElement>('simulationPick');
    pick.setAttribute('aria-pressed', String(picking));
    pick.textContent = '📍 ピンを立てる';
    document.getElementById('simulationMapPick')!.setAttribute('aria-pressed', String(picking && active));
    document.getElementById('simulationMapPickHint')!.textContent = picking && active ? 'ピン配置中：地図の海をクリック・タップ' : active ? '地点調査中：ピンを移すときは上のボタン' : '海上に波源を置いて、津波を計算';
    document.getElementById('cesiumContainer')!.classList.toggle('simulation-picking', picking && active);
    node('simulationInspect').setAttribute('aria-pressed', String(!picking));
    node('simulationPickHelp').textContent = picking ? 'クリックするたびに波源が移動し、自動で再計算します。数値の確認は「浸水深を調べる」へ。陸上は指定できません。' : '地点調査中です。地図クリックで浸水深を確認できます。波源を移すには上のピン配置ボタンを選んでください。';
  };
  const clearResult = () => { node('simulationResult').textContent = ''; };
  const emitChange = () => { clearResult(); callbacks.onChange({ ...config }); };
  for (const id of ['simulationModeOfficial', 'simulationModeCustom']) {
    input(id).addEventListener('change', () => {
      if (!input(id).checked) return;
      active = id === 'simulationModeCustom';
      node('simulationControls').hidden = !active;
      if (!active) setPicking(false);
      callbacks.onMode(active);
    });
  }
  const bindRange = (id: string, key: 'heightM' | 'radiusKm' | 'durationMinutes', unit: string) => {
    input(id).addEventListener('input', () => {
      config[key] = Number(input(id).value);
      node<HTMLOutputElement>(`${id}Output`).value = `${key === 'heightM' ? config[key].toFixed(1) : config[key]} ${unit}`;
      emitChange();
    });
  };
  bindRange('simulationHeight', 'heightM', 'm');
  bindRange('simulationRadius', 'radiusKm', 'km');
  bindRange('simulationDuration', 'durationMinutes', '分');
  for (const [id, key] of [['simulationLon', 'lon'], ['simulationLat', 'lat']] as const) {
    input(id).addEventListener('input', () => {
      const field = input(id);
      node<HTMLSelectElement>('simulationSourcePreset').value='custom';
      config[key] = field.checkValidity() ? field.valueAsNumber : NaN;
      emitChange();
    });
  }
  node<HTMLSelectElement>('simulationDomain').addEventListener('change', () => {
    config.domain = node<HTMLSelectElement>('simulationDomain').value === 'regional' ? 'regional' : 'national';
    node('simulationDomainHelp').textContent = config.domain === 'regional'
      ? '波源から東西・南北へ各3°（地形範囲内）。メッシュは約4〜6 km。範囲外は未計算です。'
      : '東経122〜150°・北緯24〜46°。範囲外は未計算です。';
    emitChange();
  });
  document.getElementById('simulationMapPick')!.addEventListener('click', () => { if (!active) input('simulationModeCustom').click(); callbacks.onPick(); });
  document.getElementById('simulationMapCancel')!.addEventListener('click', () => callbacks.onCancel());
  node<HTMLSelectElement>('simulationSourcePreset').addEventListener('change', () => {
    const preset: Record<string, [number,number]> = {noto:[136.5,38],niigata:[138,38.5],akita:[138.5,40],hokkaido:[139,43.5],nankai:[134,32]};
    const point = preset[node<HTMLSelectElement>('simulationSourcePreset').value]; if(!point)return;
    config.lon=point[0];config.lat=point[1];input('simulationLon').value=String(point[0]);input('simulationLat').value=String(point[1]);
    emitChange(); callbacks.onFlyToSource?.();
  });
  node('simulationPick').addEventListener('click', () => callbacks.onPick());
  node('simulationInspect').addEventListener('click', () => callbacks.onInspect());
  node('simulationRun').addEventListener('click', () => {
    for (const id of ['simulationLon', 'simulationLat']) if (!input(id).reportValidity()) return;
    callbacks.onRun();
  });
  node('simulationCancel').addEventListener('click', () => callbacks.onCancel());
  return {
    setStatus(text: string) { status.textContent = text; document.getElementById('simulationLoadingDetail')!.textContent = text; },
    setBusy(busy: boolean) { loading.hidden = !busy; node('simulationResult').setAttribute('aria-busy', String(busy)); if (busy) document.getElementById('simulationMapProgress')!.removeAttribute('value'); },
    setProgress(percent: number) {
      const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
      (document.getElementById('simulationMapProgress') as HTMLProgressElement).value = value;
      node<HTMLProgressElement>('simulationProgress').value = value;
      node<HTMLOutputElement>('simulationProgressOutput').value = `${Math.round(value)}%`;
    },
    setResult(text: string) { node('simulationResult').textContent = text; },
    setSource(lon: number, lat: number) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      node<HTMLSelectElement>('simulationSourcePreset').value='custom';
      config.lon = Math.round(lon * 1000) / 1000; config.lat = Math.round(lat * 1000) / 1000;
      input('simulationLon').value = String(Math.round(lon * 1000) / 1000);
      input('simulationLat').value = String(Math.round(lat * 1000) / 1000);
    },
    getConfig(): SimulationConfig { return { ...config }; },
    isActive() { return active; },
    setPicking,
  };
}
