import type { SimulationConfig, TerrainGrid } from './simulationTypes';

type Metadata = {
  version: number; width: number; height: number; west: number; south: number; step: number;
  encoding: string; order: string; registration: string; units: string;
  byteLength: number; sha256: string; file: string;
};
let cached: Promise<TerrainGrid> | undefined;

/** Validate the bundled numerical terrain before it enters the physical solver. */
export async function decodeTerrain(metadata: unknown, bytes: ArrayBuffer): Promise<TerrainGrid> {
  if (!metadata || typeof metadata !== 'object') throw new Error('地形メタデータが不正です');
  const m = metadata as Metadata;
  if (m.version !== 1 || m.width !== 561 || m.height !== 441 || m.west !== 122 || m.south !== 24 ||
      m.step !== .05 || m.encoding !== 'int16-le' || m.order !== 'south-to-north,row-major' ||
      m.registration !== 'cell-center' || m.units !== 'm' || m.file !== 'etopo1-japan-3min.bin' ||
      m.byteLength !== m.width * m.height * 2 || bytes.byteLength !== m.byteLength ||
      !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error('地形の形状・座標・バイト長が不正です');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
  if (hash !== m.sha256) throw new Error('地形データの検査値が一致しません');
  const elevation = new Float32Array(m.width * m.height);
  const view = new DataView(bytes);
  for (let i = 0; i < elevation.length; i++) {
    const value = view.getInt16(i * 2, true);
    if (value < -12000 || value > 9000) throw new Error('地形データに欠損または異常値があります');
    elevation[i] = value;
  }
  return { width: m.width, height: m.height, west: m.west, south: m.south, step: m.step, elevation };
}

/** Failed downloads are not cached, so the retry button can recover. */
export function loadTerrain(): Promise<TerrainGrid> {
  if (!cached) cached = (async () => {
    const response = await fetch('/simulation/terrain.json');
    if (!response.ok) throw new Error(`地形情報を取得できません (${response.status})`);
    const metadata: unknown = await response.json();
    const binary = await fetch('/simulation/etopo1-japan-3min.bin');
    if (!binary.ok) throw new Error(`数値地形を取得できません (${binary.status})`);
    return decodeTerrain(metadata, await binary.arrayBuffer());
  })().catch(error => { cached = undefined; throw error; });
  return cached;
}

/** Coordinates always identify sample centers, including clipped regional grids. */
export function selectGrid(grid: TerrainGrid, config: SimulationConfig): TerrainGrid {
  const { width, height, west, south, step, elevation } = grid;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 ||
      !Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(step) || step <= 0 ||
      elevation.length !== width * height) throw new Error('地形グリッドが不正です');
  if (!Number.isFinite(config.lon) || !Number.isFinite(config.lat) || config.lon < west || config.lat < south ||
      config.lon > west + (width - 1) * step || config.lat > south + (height - 1) * step)
    throw new Error('波源が数値地形の範囲外です');
  if (config.domain !== 'national' && config.domain !== 'regional') throw new Error('計算範囲が不正です');
  const stride = config.domain === 'national' ? 2 : 1;
  const x0 = stride === 2 ? 0 : Math.max(0, Math.ceil((config.lon - 3 - west) / step - 1e-8));
  const y0 = stride === 2 ? 0 : Math.max(0, Math.ceil((config.lat - 3 - south) / step - 1e-8));
  const x1 = stride === 2 ? width - 1 : Math.min(width - 1, Math.floor((config.lon + 3 - west) / step + 1e-8));
  const y1 = stride === 2 ? height - 1 : Math.min(height - 1, Math.floor((config.lat + 3 - south) / step + 1e-8));
  const outWidth = Math.floor((x1 - x0) / stride) + 1;
  const outHeight = Math.floor((y1 - y0) / stride) + 1;
  const output = new Float32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++)
    output[y * outWidth + x] = elevation[(y0 + y * stride) * width + x0 + x * stride];
  return { width: outWidth, height: outHeight, west: west + x0 * step, south: south + y0 * step, step: step * stride, elevation: output };
}
