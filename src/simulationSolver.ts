import type { SimulationConfig, SimulationProgress, SimulationResult, TerrainGrid } from './simulationTypes';

const G = 9.81;
const DRY = 1e-7;

/** Boundary-connected negative terrain is sea; isolated below-sea-level land stays dry. */
export function oceanMask(grid: TerrainGrid): Uint8Array {
  const { width: w, height: h, elevation: z } = grid;
  const mask = new Uint8Array(w * h), queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const add = (i: number) => { if (!mask[i] && z[i] < 0) { mask[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { add(y * w); add(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % w, y = Math.floor(i / w);
    if (x) add(i - 1); if (x < w - 1) add(i + 1);
    if (y) add(i - w); if (y < h - 1) add(i + w);
  }
  return mask;
}

/** Experimental first-order finite-volume SWE model; not a validated hazard prediction. */
export function runSimulation(grid: TerrainGrid, config: SimulationConfig,
  onProgress?: (progress: SimulationProgress) => void): SimulationResult {
  const { width: w, height: rows, elevation: z, west, south, step } = grid;
  const n = w * rows;
  if (!Number.isInteger(w) || !Number.isInteger(rows) || w < 3 || rows < 3 || n > 1_000_000 ||
      z.length !== n || ![west, south, step].every(Number.isFinite) || step <= 0 ||
      south < -85 || south + (rows - 1) * step > 85 || !z.every(Number.isFinite))
    throw new Error('地形グリッドが不正です。');
  if (![config.lon, config.lat, config.heightM, config.radiusKm, config.durationMinutes].every(Number.isFinite) ||
      config.heightM < 0 || config.heightM > 30 || config.radiusKm < 1 || config.radiusKm > 100 ||
      config.durationMinutes <= 0 || config.durationMinutes > 120)
    throw new Error('計算条件が範囲外です。');
  const sx = Math.round((config.lon - west) / step), sy = Math.round((config.lat - south) / step);
  if (config.lon < west || config.lon > west + (w - 1) * step || config.lat < south ||
      config.lat > south + (rows - 1) * step) throw new Error('波源が計算範囲外です。');
  const ocean = oceanMask(grid);
  if (!ocean[sy * w + sx]) throw new Error('波源は外海とつながる海域に指定してください。');
  // Constant metric at domain midpoint: this is a planar approximation, not spherical SWE.
  const dy = step * 111320, dx = dy * Math.cos((south + (rows - 1) * step / 2) * Math.PI / 180);
  const h = new Float64Array(n), u = new Float64Array(n), v = new Float64Array(n);
  const dh = new Float64Array(n), du = new Float64Array(n), dv = new Float64Array(n);
  const maxSurface = new Float32Array(n), maxDepth = new Float32Array(n);
  for (let y = 0; y < rows; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (ocean[i]) {
      const r2 = (((west + x * step - config.lon) / step * dx) ** 2 +
        ((south + y * step - config.lat) / step * dy) ** 2) / (config.radiusKm * 1000) ** 2;
      const eta = r2 <= 36 ? config.heightM * Math.exp(-r2 / 2) : 0;
      h[i] = -z[i] + eta; maxSurface[i] = eta;
    }
  }
  // Hydrostatic reconstruction, Audusse-style side-specific bed-pressure correction.
  // For boundary faces l===r supplies a zero-gradient ghost cell; outgoing flux leaves the domain.
  const face = (l: number, r: number, axis: number, leftInside: boolean, rightInside: boolean) => {
    const hl = h[l], hr = h[r], top = Math.max(z[l], z[r]);
    const a = Math.max(0, hl + z[l] - top), b = Math.max(0, hr + z[r] - top);
    const ul = hl > DRY ? u[l] / hl : 0, ur = hr > DRY ? u[r] / hr : 0;
    const vl = hl > DRY ? v[l] / hl : 0, vr = hr > DRY ? v[r] / hr : 0;
    const nl = axis === 0 ? ul : vl, nr = axis === 0 ? ur : vr;
    const speed = Math.max(Math.abs(nl) + Math.sqrt(G * a), Math.abs(nr) + Math.sqrt(G * b));
    const fh = 0.5 * (a * nl + b * nr - speed * (b - a));
    const fu = 0.5 * (a * nl * ul + b * nr * ur + (axis === 0 ? 0.5 * G * (a*a + b*b) : 0) - speed * (b * ur - a * ul));
    const fv = 0.5 * (a * nl * vl + b * nr * vr + (axis === 1 ? 0.5 * G * (a*a + b*b) : 0) - speed * (b * vr - a * vl));
    const inv = axis === 0 ? 1 / dx : 1 / dy;
    if (leftInside) {
      const correction = 0.5 * G * (hl * hl - a * a);
      dh[l] -= fh * inv; du[l] -= (fu + (axis === 0 ? correction : 0)) * inv;
      dv[l] -= (fv + (axis === 1 ? correction : 0)) * inv;
    }
    if (rightInside) {
      const correction = 0.5 * G * (hr * hr - b * b);
      dh[r] += fh * inv; du[r] += (fu + (axis === 0 ? correction : 0)) * inv;
      dv[r] += (fv + (axis === 1 ? correction : 0)) * inv;
    }
  };
  let elapsedSec = 0, steps = 0, lastProgress = -Infinity;
  const totalSec = config.durationMinutes * 60;
  onProgress?.({ elapsedSec, totalSec, steps });
  while (elapsedSec < totalSec) {
    let rate = 0;
    for (let i = 0; i < n; i++) if (h[i] > DRY) {
      const c = Math.sqrt(G * h[i]);
      rate = Math.max(rate, (Math.abs(u[i] / h[i]) + c) / dx + (Math.abs(v[i] / h[i]) + c) / dy);
    }
    const dt = Math.min(totalSec - elapsedSec, rate > 0 ? 0.4 / rate : totalSec);
    if (!Number.isFinite(dt) || dt < 1e-7 || steps > 100_000) throw new Error('数値計算が不安定になりました。条件を変更してください。');
    dh.fill(0); du.fill(0); dv.fill(0);
    for (let y = 0; y < rows; y++) {
      const start = y * w;
      face(start, start, 0, false, true);
      for (let x = 0; x < w - 1; x++) face(start + x, start + x + 1, 0, true, true);
      face(start + w - 1, start + w - 1, 0, true, false);
    }
    for (let x = 0; x < w; x++) {
      face(x, x, 1, false, true);
      for (let y = 0; y < rows - 1; y++) face(y * w + x, (y + 1) * w + x, 1, true, true);
      face((rows - 1) * w + x, (rows - 1) * w + x, 1, true, false);
    }
    for (let i = 0; i < n; i++) {
      const next = h[i] + dt * dh[i];
      if (!Number.isFinite(next) || next < -1e-6) throw new Error('水深の数値異常が発生しました。');
      h[i] = Math.max(0, next);
      u[i] += dt * du[i]; v[i] += dt * dv[i];
      if (!Number.isFinite(u[i]) || !Number.isFinite(v[i])) throw new Error('流速の数値異常が発生しました。');
      if (h[i] <= DRY) { u[i] = 0; v[i] = 0; }
      if (ocean[i]) maxSurface[i] = Math.max(maxSurface[i], h[i] + z[i]);
      else maxDepth[i] = Math.max(maxDepth[i], h[i]);
    }
    elapsedSec += dt; steps++;
    if (elapsedSec - lastProgress >= totalSec / 100) {
      onProgress?.({ elapsedSec, totalSec, steps }); lastProgress = elapsedSec;
    }
  }
  onProgress?.({ elapsedSec, totalSec, steps });
  return { grid, finalDepth: h, maxSurface, maxDepth, ocean, elapsedSec, steps };
}
