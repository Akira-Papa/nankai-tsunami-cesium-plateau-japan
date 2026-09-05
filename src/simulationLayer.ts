import * as Cesium from 'cesium';
import type { SimulationResult, TerrainGrid } from './simulationTypes';

export const SIMULATION_COLOR_THRESHOLDS = [0.1, 0.3, 1, 3, 10] as const;
export const OCEAN_COLORS = ['#c6edff', '#82d3f5', '#3aafe5', '#1679cb', '#164aab', '#172b76'] as const;
export const LAND_COLORS = ['#fff4a3', '#ffe06b', '#ffb547', '#fa7834', '#e33a25', '#a61127'] as const;
/** Values at/below 1 cm are transparent, never a statement of safety. */
export function simulationColor(value: number, ocean: boolean): string | null {
  if (!Number.isFinite(value) || value <= 0.01) return null;
  return (ocean ? OCEAN_COLORS : LAND_COLORS)[SIMULATION_COLOR_THRESHOLDS.filter(t => value >= t).length];
}
export function simulationBounds(grid: TerrainGrid): [number, number, number, number] {
  return [grid.west - grid.step / 2, grid.south - grid.step / 2,
    grid.west + (grid.width - 0.5) * grid.step, grid.south + (grid.height - 0.5) * grid.step];
}
/** West/south inclusive; east/north exclusive. Input coordinates represent cell centers. */
export function simulationCellIndex(grid: TerrainGrid, lon: number, lat: number): number | null {
  const [west, south, east, north] = simulationBounds(grid);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < west || lon >= east || lat < south || lat >= north) return null;
  // Decimal geographic steps are not exact binary floats. Snap only roundoff
  // at internal edges so their ownership follows the same half-open contract.
  const axis = (coordinate: number, origin: number) => {
    const value = (coordinate - origin) / grid.step;
    const nearest = Math.round(value);
    return Math.floor(Math.abs(value - nearest) < 1e-10 ? nearest : value);
  };
  const col = Math.min(grid.width - 1, axis(lon, west));
  const row = Math.min(grid.height - 1, axis(lat, south));
  return row * grid.width + col;
}
export function simulationPixels(result: SimulationResult): Uint8ClampedArray {
  const { width, height } = result.grid;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const cell = row * width + col;
    const color = simulationColor(result.ocean[cell] ? result.maxSurface[cell] : result.maxDepth[cell], !!result.ocean[cell]);
    if (!color) continue;
    const pixel = ((height - 1 - row) * width + col) * 4;
    pixels[pixel] = parseInt(color.slice(1, 3), 16);
    pixels[pixel + 1] = parseInt(color.slice(3, 5), 16);
    pixels[pixel + 2] = parseInt(color.slice(5, 7), 16);
    pixels[pixel + 3] = 210;
  }
  return pixels;
}
export function inspectSimulation(result: SimulationResult | null, lon: number, lat: number): string {
  if (!result) return '未計算です。条件を指定して計算してください。';
  const index = simulationCellIndex(result.grid, lon, lat);
  if (index === null) return '計算領域外・未計算です。色がないことは安全を意味しません。';
  const ocean = !!result.ocean[index];
  const value = ocean ? result.maxSurface[index] : result.maxDepth[index];
  const latKm = result.grid.step * 111.32;
  const lonKm = latKm * Math.cos(lat * Math.PI / 180);
  const metric = ocean ? '最大水位上昇（海面基準）' : '最大浸水深（地盤から）';
  return `地形標高 ${result.grid.elevation[index].toFixed(1)} m（海面基準）／${metric} ${value.toFixed(2)} m。` +
    (value <= 0.01 ? '計算期間内では表示閾値 0.01 m 以下。' : '') +
    `計算時間 ${(result.elapsedSec / 60).toFixed(0)} 分、粗いメッシュ 約 ${lonKm.toFixed(1)} × ${latKm.toFixed(1)} km。未検証の試算であり、安全や建物ごとの浸水を判定できません。`;
}

export function createSimulationLayer(viewer: Cesium.Viewer) {
  let generation = 0;
  let disposed = false;
  let result: SimulationResult | null = null;
  let imagery: Cesium.ImageryLayer | undefined;
  let frame: Cesium.Entity | undefined;
  let renderError = '';
  function clear() {
    generation++;
    result = null;
    renderError = '';
    if (imagery) viewer.imageryLayers.remove(imagery, true);
    if (frame) viewer.entities.remove(frame);
    imagery = undefined;
    frame = undefined;
    viewer.scene.requestRender();
  }
  async function setResult(next: SimulationResult) {
    if (disposed) return;
    clear();
    result = next;
    const token = generation;
    const { grid } = next;
    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('結果画像を作成できませんでした。');
    const image = context.createImageData(grid.width, grid.height);
    image.data.set(simulationPixels(next));
    context.putImageData(image, 0, 0);
    const [west, south, east, north] = simulationBounds(grid);
    const rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north);
    frame = viewer.entities.add({
      name: '試算領域：枠の外は未計算',
      polyline: { positions: Cesium.Cartesian3.fromDegreesArray([west, south, east, south, east, north, west, north, west, south]), width: 2,
        material: Cesium.Color.fromCssColorString('#fcac38'), clampToGround: true },
      position: Cesium.Cartesian3.fromDegrees((west + east) / 2, north),
      label: { text: `試算領域｜粗い ${grid.step}° メッシュ｜領域外は未計算`, font: '13px sans-serif',
        fillColor: Cesium.Color.WHITE, showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('#193448'),
        disableDepthTestDistance: Number.POSITIVE_INFINITY, pixelOffset: new Cesium.Cartesian2(0, -12) },
    });
    // A single image avoids tens of thousands of primitive allocations. fromUrl
    // decodes asynchronously; generation prevents stale images returning after clear.
    await Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
      rectangle, credit: '独自浅水試算・地形 NOAA ETOPO1（粗いメッシュ／未検証）',
    }).then(provider => {
      if (disposed || generation !== token || viewer.isDestroyed()) return;
      imagery = new Cesium.ImageryLayer(provider, { rectangle, alpha: 0.85,
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST });
      viewer.imageryLayers.add(imagery);
      viewer.scene.requestRender();
    }).catch(() => {
      if (generation === token && !disposed) { renderError = '計算は終了しましたが、色レイヤーの表示に失敗しました。再計算してください。'; throw new Error(renderError); }
    });
    viewer.scene.requestRender();
  }
  return { setResult, clear, dispose() { clear(); disposed = true; },
    inspect(lon: number, lat: number) { return renderError || inspectSimulation(result, lon, lat); } };
}
