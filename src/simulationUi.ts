import type { SimulationConfig } from './simulationTypes';
import './simulationUi.css';
import { OCEAN_COLORS, LAND_COLORS } from './simulationLayer';

export interface SimulationUiCallbacks {
  onMode(active: boolean): void;
  onChange(config: SimulationConfig): void;
  onPick(): void;
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
      <p class="simulation-notice">数kmメッシュの実験計算・実災害の予測ではありません</p>
      <div class="simulation-field">
        <label for="simulationHeight">波源の津波高（初期水面上昇）</label>
        <output id="simulationHeightOutput" for="simulationHeight">5.0 m</output>
        <input id="simulationHeight" type="range" min="0.1" max="30" step="0.1" value="5" aria-describedby="simulationHeightHelp">
        <div class="simulation-range"><span>0.1 m</span><span>30 m</span></div>
        <p id="simulationHeightHelp" class="simulation-help">沿岸到達高ではありません。波源で水面を持ち上げる高さです。</p>
      </div>
      <fieldset class="simulation-source">
        <legend>仮想波源（震源位置の代用）</legend>
        <button id="simulationPick" type="button" aria-pressed="false" aria-describedby="simulationPickHelp">地図の海上にピンを置く</button>
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
        <div class="simulation-color-scale" aria-label="水位上昇と浸水深の色階級">${['0.01超','0.1–','0.3–','1–','3–','10以上'].map((label,i)=>`<div><i style="background:${OCEAN_COLORS[i]}"></i><i style="background:${LAND_COLORS[i]}"></i><span>${label}</span></div>`).join('')}</div>
        <p class="simulation-help">単位 m。上段は海・下段は陸。0.01 m以下は透明。計算期間の最大値を示します。</p>
      </div>
      <details class="simulation-assumptions"><summary>計算の前提と解像度</summary>
        <p>海底・陸上の標高を使い、浅水方程式を計算します。ピンは断層の代わりに置く仮想の波源です。初期水面を釣り鐘状に上昇させ、潮位は0 mとします。断層破壊・底面摩擦・堤防・潮汐は含まず、平面近似で計算します。</p>
        <p>数kmより小さい河川・堤防・建物・沿岸の低地は表現できません。建物単位の浸水や避難の判断には使えません。全国表示でも一部離島は計算範囲外です。地形は NOAA ETOPO1（平均海面基準）を間引いて使用しています。</p>
      </details>
    </div>`;
  container.append(root);
  const node = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const input = (id: string) => node<HTMLInputElement>(id);
  let active = false;
  let config: SimulationConfig = { lon: 134, lat: 32, heightM: 5, radiusKm: 50, durationMinutes: 30, domain: 'national' };
  const status = node('simulationStatus');
  const setPicking = (picking: boolean) => {
    const pick = node<HTMLButtonElement>('simulationPick');
    pick.setAttribute('aria-pressed', String(picking));
    pick.textContent = picking ? '海上をクリック（もう一度で解除）' : '地図の海上にピンを置く';
    node('simulationPickHelp').textContent = picking ? '地図上の海を選択してください。陸上は波源に指定できません。' : 'ボタンを押してから、地図の海上をクリックしてください。';
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
  node('simulationPick').addEventListener('click', () => callbacks.onPick());
  node('simulationRun').addEventListener('click', () => {
    for (const id of ['simulationLon', 'simulationLat']) if (!input(id).reportValidity()) return;
    callbacks.onRun();
  });
  node('simulationCancel').addEventListener('click', () => callbacks.onCancel());
  return {
    setStatus(text: string) { status.textContent = text; },
    setProgress(percent: number) {
      const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
      node<HTMLProgressElement>('simulationProgress').value = value;
      node<HTMLOutputElement>('simulationProgressOutput').value = `${Math.round(value)}%`;
    },
    setResult(text: string) { node('simulationResult').textContent = text; },
    setSource(lon: number, lat: number) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      config.lon = Math.round(lon * 1000) / 1000; config.lat = Math.round(lat * 1000) / 1000;
      input('simulationLon').value = String(Math.round(lon * 1000) / 1000);
      input('simulationLat').value = String(Math.round(lat * 1000) / 1000);
    },
    getConfig(): SimulationConfig { return { ...config }; },
    isActive() { return active; },
    setPicking,
  };
}
