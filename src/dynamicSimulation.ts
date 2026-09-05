import * as Cesium from 'cesium';
import { initSimulationUi } from './simulationUi';
import { loadTerrain, selectGrid } from './simulationTerrain';
import { createSimulationLayer } from './simulationLayer';
import type { SimulationConfig, SimulationResult, SimulationProgress } from './simulationTypes';

export function initDynamicSimulation(viewer: Cesium.Viewer, onMode: (active: boolean) => void, readout: (text: string) => void, onStatus?: (text: string) => void) {
  const container = document.createElement('section');
  container.className = 'simulation-host';
  document.querySelector('.panel-intro')!.after(container);
  const layer = createSimulationLayer(viewer);
  let active = false, picking = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let worker: Worker | undefined, result: SimulationResult | undefined;
  let pin: Cesium.Entity | undefined;
  let running = false;
  const ui = initSimulationUi(container, {
    onMode(value) {
      active = value;
      invalidate();
      picking = false; ui.setPicking(false);
      document.querySelector<HTMLElement>('#scenarioTitle')!.closest('section')!.hidden = value;
      const share = document.getElementById('shareButton') as HTMLButtonElement;
      share.disabled = value;
      share.title = value ? '任意条件の試算は共有URLに含まれません' : '現在の視点を共有';
      if (pin) pin.show = value;
      onMode(value);
      if (value) { showPin(); schedule(); }
    },
    onChange() { if (active) { showPin(); schedule(); } },
    onPick() { picking = !picking; ui.setPicking(picking); },
    onRun() { if (active) { invalidate(); void calculate(); } },
    onCancel() { invalidate(); setStatus('計算を中止しました。再計算ボタンで実行できます。'); },
  });
  function setStatus(text: string) { ui.setStatus(text); if (active) onStatus?.(text); }
  function invalidate() {
    generation++; clearTimeout(timer); timer = undefined;
    worker?.terminate(); worker = undefined; running = false;
    result = undefined; layer.clear(); ui.setResult(''); ui.setProgress(0);
    if (active) readout('条件を変更したため結果は未計算です。計算完了後に地図をクリックしてください。');
  }
  function showPin() {
    const c = ui.getConfig();
    if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) { if(pin)pin.show=false; viewer.scene.requestRender(); return; }
    const pos = Cesium.Cartesian3.fromDegrees(c.lon, c.lat);
    if (!pin) pin = viewer.entities.add({
      position: pos,
      billboard: { image: new Cesium.PinBuilder().fromColor(Cesium.Color.fromCssColorString('#ef6c42'), 44).toDataURL(), verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Infinity },
      label: { text: '仮想波源', font: 'bold 13px sans-serif', pixelOffset: new Cesium.Cartesian2(0, -53), fillColor: Cesium.Color.WHITE, showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('#122d42'), disableDepthTestDistance: Infinity },
    });
    pin.position = new Cesium.ConstantPositionProperty(pos); pin.show = active;
    viewer.scene.requestRender();
  }
  function schedule() {
    invalidate();
    setStatus('条件変更を反映して再計算します…');
    timer = setTimeout(() => { void calculate(); }, 700);
  }
  async function calculate() {
    if (!active) return;
    const id = ++generation;
    const config: SimulationConfig = ui.getConfig();
    running = true; setStatus('計算用の海底・陸上地形を読込中…');
    try {
      const terrain = await loadTerrain();
      if (id !== generation || !active) return;
      const grid = selectGrid(terrain, config);
      const resolution = `${grid.step.toFixed(2)}度（緯度方向 約${(grid.step * 111.32).toFixed(1)}km）`;
      setStatus(`${grid.width}×${grid.height}セル・${resolution}で計算中…`);
      worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
      worker.onerror = () => reject('計算スレッドでエラーが発生しました。再計算してください。');
      worker.onmessage = async (event: MessageEvent) => {
        if (id !== generation || !active) return;
        const m = event.data as { type: string; id: number; progress?: SimulationProgress; result?: SimulationResult; message?: string };
        if (m.id !== id) return;
        if (m.type === 'progress' && m.progress) {
          ui.setProgress(Math.min(99, 100 * m.progress.elapsedSec / m.progress.totalSec));
          setStatus(`${(m.progress.elapsedSec / 60).toFixed(1)} / ${config.durationMinutes}分を計算中・${resolution}`);
        } else if (m.type === 'result' && m.result) {
          const completed = m.result; worker?.terminate(); worker = undefined;
          setStatus('計算結果を地図へ描画中…');
          try { await layer.setResult(completed); } catch (error) { reject(error instanceof Error ? error.message : '結果を表示できません'); return; }
          if (id !== generation || !active) return;
          result = completed; running = false; ui.setProgress(100);
          let maxLand = 0, maxSea = 0, landCount = 0;
          for (let i = 0; i < result.maxDepth.length; i++) {
            if (result.ocean[i]) maxSea = Math.max(maxSea, result.maxSurface[i]);
            else if (result.maxDepth[i] > .01) { landCount++; maxLand = Math.max(maxLand, result.maxDepth[i]); }
          }
          setStatus(`計算完了：${config.durationMinutes}分間・${result.steps.toLocaleString()}ステップ・${resolution}`);
          ui.setResult(`海上の最大水位上昇 ${maxSea.toFixed(2)}m ／ 陸上の最大浸水深 ${maxLand.toFixed(2)}m（${landCount.toLocaleString()}セル）。計算期間内の最大値です。細かな沿岸低地を表せないため、無着色から安全とは判断できません。`);
          readout('任意条件の計算結果を表示しました。地図をクリックするとセルの数値を確認できます。');
        } else if (m.type === 'error') reject(m.message ?? '計算に失敗しました');
      };
      worker.postMessage({ type: 'start', id, grid, config }, [grid.elevation.buffer]);
    } catch (error) {
      if (id === generation) reject(error instanceof Error ? error.message : String(error));
    }
    function reject(message: string) {
      if (id !== generation) return;
      worker?.terminate(); worker = undefined; running = false; result = undefined;
      layer.clear(); ui.setProgress(0); ui.setResult('');
      setStatus(`計算できません：${message}`);
      readout('有効な計算結果はありません。波源の位置や条件を確認して再計算してください。');
    }
  }
  return {
    get active() { return active; }, get running() { return running; }, get result() { return result; },
    get config() { return ui.getConfig(); },
    handleClick(lon: number, lat: number) {
      if (!active) return false;
      if (picking) {
        if (lon < 122 || lon > 150 || lat < 24 || lat > 46) { setStatus('計算範囲（東経122–150度、北緯24–46度）の海上を選んでください。'); return true; }
        ui.setSource(lon, lat); picking = false; ui.setPicking(false); showPin(); schedule();
      } else readout(result ? layer.inspect(lon, lat) : 'まだ計算結果がありません。完了後に地点を選択してください。');
      return true;
    },
    cancel() { invalidate(); },
    retry() { if (active) { invalidate(); void calculate(); } },
  };
}
