/** Computed maximum-depth cells draped on terrain, never an inferred water surface. */
import * as Cesium from 'cesium';

export interface InundationCell {
  lon: number;
  lat: number;
  depthM: number;
  arrivalSec: number | null;
  sizeM: number;
}
export interface InundationDisplay {
  mode: 'max' | 'arrival';
  minutes: number;
  opacity: number;
}
export const MAX_RENDER_CELLS = 30000;
const BATCH_SIZE = 256;
/** Approximate GSI inundation-depth palette; classes are metres, lower-inclusive. */
export const DEPTH_COLORS = ['#ffffb3', '#f7f38d', '#f8c785', '#f5a079', '#ef7b84', '#d76b9d', '#aa64ad', '#7956a5'] as const;
export function depthColor(depthM: number): string {
  if (!Number.isFinite(depthM) || depthM <= 0) return 'transparent';
  const index = [0.3, 0.5, 1, 3, 5, 10, 20].filter((limit) => depthM >= limit).length;
  return DEPTH_COLORS[index];
}
export function validCell(cell: InundationCell): boolean {
  return Number.isFinite(cell.lon) && cell.lon >= -180 && cell.lon <= 180 &&
    Number.isFinite(cell.lat) && Math.abs(cell.lat) < 85 &&
    Number.isFinite(cell.depthM) && cell.depthM > 0 &&
    Number.isFinite(cell.sizeM) && cell.sizeM > 0 && cell.sizeM <= 100000;
}
export function cellVisible(cell: InundationCell, display: InundationDisplay): boolean {
  return validCell(cell) && (display.mode === 'max' ||
    (cell.arrivalSec !== null && Number.isFinite(cell.arrivalSec) && cell.arrivalSec >= 0 &&
      cell.arrivalSec <= display.minutes * 60));
}
/** WGS84 local metric approximation, suitable for Japan's 10m–km display cells. */
export function cellBounds(cell: InundationCell): [number, number, number, number] {
  // Match the exact aggregation grid used by scripts/precompute_inundation.py.
  const latMetres = 111320;
  const lonMetres = 111320 * Math.cos(cell.lat * Math.PI / 180);
  const dy = cell.sizeM / (2 * latMetres);
  const dx = cell.sizeM / (2 * lonMetres);
  return [cell.lon - dx, cell.lat - dy, cell.lon + dx, cell.lat + dy];
}

export function createInundationLayer(viewer: Cesium.Viewer) {
  type Batch = { primitive: Cesium.GroundPrimitive; cells: InundationCell[]; ids: string[]; version: number };
  let cells: InundationCell[] = [];
  let batches: Batch[] = [];
  let display: InundationDisplay = { mode: 'max', minutes: 0, opacity: 0.7 };
  let generation = 0;
  let version = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const render = () => { if (!disposed && !viewer.isDestroyed()) viewer.scene.requestRender(); };
  const removeBatches = () => {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const batch of batches) viewer.scene.primitives.remove(batch.primitive);
    batches = [];
  };
  // One batch update per frame avoids long main-thread attribute loops during timeline scrubbing.
  const detach = viewer.scene.preRender.addEventListener(() => {
    const pending = batches.filter((batch) => batch.version !== version);
    for (const batch of pending.filter((item) => item.primitive.ready).slice(0, 8)) {
      batch.cells.forEach((cell, i) => {
        const attrs = batch.primitive.getGeometryInstanceAttributes(batch.ids[i]);
        attrs.show = Cesium.ShowGeometryInstanceAttribute.toValue(cellVisible(cell, display));
        attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(
          Cesium.Color.fromCssColorString(depthColor(cell.depthM)).withAlpha(display.opacity));
      });
      batch.version = version;
      batch.primitive.show = true;
    }
    if (pending.length > 0) render();
  });
  function clear() {
    if (disposed) return;
    removeBatches();
    cells = [];
    render();
  }
  return {
    setCells(input: InundationCell[]) {
      if (disposed) return;
      // Refuse an oversized dataset, rather than silently showing incomplete inundation.
      if (input.length > MAX_RENDER_CELLS) throw new RangeError(`浸水描画は${MAX_RENDER_CELLS}セルまでです。表示範囲を狭めるか集約データを使用してください。`);
      removeBatches();
      cells = input.filter(validCell).map((cell) => ({ ...cell }));
      const token = generation;
      let offset = 0;
      function appendBatch() {
        if (disposed || generation !== token || viewer.isDestroyed()) return;
        const chunk = cells.slice(offset, offset + BATCH_SIZE);
        if (!chunk.length) return;
        const ids = chunk.map((_, i) => `inundation-${token}-${offset + i}`);
        const instances = chunk.map((cell, i) => new Cesium.GeometryInstance({
          id: ids[i],
          geometry: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(...cellBounds(cell)),
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(depthColor(cell.depthM)).withAlpha(display.opacity)),
            show: new Cesium.ShowGeometryInstanceAttribute(cellVisible(cell, display)),
          },
        }));
        const primitive = viewer.scene.primitives.add(new Cesium.GroundPrimitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
          classificationType: Cesium.ClassificationType.TERRAIN,
          asynchronous: true,
          allowPicking: false,
        }));
        batches.push({ primitive, cells: chunk, ids, version });
        offset += chunk.length;
        render();
        if (offset < cells.length) timer = setTimeout(appendBatch, 0);
      }
      timer = setTimeout(appendBatch, 0);
      render();
    },
    setDisplay(next: InundationDisplay) {
      if (disposed) return;
      if(next.mode===display.mode&&next.minutes===display.minutes&&next.opacity===display.opacity)return;
      display = {
        mode: next.mode === 'arrival' ? 'arrival' : 'max',
        minutes: Number.isFinite(next.minutes) ? Math.max(0, next.minutes) : 0,
        opacity: Number.isFinite(next.opacity) ? Math.max(0, Math.min(1, next.opacity)) : 0.7,
      };
      version++;
      // Never expose old-time cells while their attributes are being updated.
      for(const batch of batches) batch.primitive.show=false;
      render();
    },
    clear,
    dispose() {
      if (disposed) return;
      clear();
      detach();
      disposed = true;
    },
    /** Counts accepted/filter-matching cells; GPU preparation may still be in progress. */
    stats() { return { total: cells.length, visible: cells.filter((cell) => cellVisible(cell, display)).length, preparedBatches:batches.filter(b=>b.primitive.ready).length, pendingBatches:Math.max(0,Math.ceil(cells.length/BATCH_SIZE)-batches.length)+batches.filter(b=>!b.primitive.ready||b.version!==version).length }; },
  };
}
