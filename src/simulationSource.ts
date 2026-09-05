import type { TerrainGrid } from './simulationTypes';

/** Restrict a single-basin hypothetical source to sea reached along water paths.
 * Eight-neighbour shortest paths avoid transmitting the initial displacement
 * through an island or into another basin. Diagonals never cut dry corners. */
export function sourceFootprint(grid: TerrainGrid, ocean: Uint8Array, source: number, dx: number, dy: number, radiusM: number): Uint8Array {
  const n = grid.width * grid.height, distance = new Float64Array(n).fill(Infinity), mask = new Uint8Array(n);
  const heap: { index: number; distance: number }[] = [];
  function push(index: number, d: number) {
    let i = heap.length; heap.push({ index, distance: d });
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p].distance <= d) break; heap[i] = heap[p]; i = p; }
    heap[i] = { index, distance: d };
  }
  function pop() {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1].distance < heap[c].distance) c++; if (heap[c].distance >= last.distance) break; heap[i] = heap[c]; i = c; } heap[i] = last; }
    return first;
  }
  distance[source] = 0; push(source, 0);
  while (heap.length) {
    const node = pop(); if (node.distance !== distance[node.index]) continue;
    mask[node.index] = 1;
    const x = node.index % grid.width, y = Math.floor(node.index / grid.width);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if ((!ox && !oy) || x + ox < 0 || x + ox >= grid.width || y + oy < 0 || y + oy >= grid.height) continue;
      const next = node.index + oy * grid.width + ox;
      if (!ocean[next] || (ox && oy && (!ocean[node.index + ox] || !ocean[node.index + oy * grid.width]))) continue;
      const d = node.distance + Math.hypot(ox * dx, oy * dy);
      if (d <= radiusM && d < distance[next]) { distance[next] = d; push(next, d); }
    }
  }
  return mask;
}
