export interface TerrainGrid {
  width: number; height: number; west: number; south: number; step: number;
  elevation: Float32Array;
}
export interface SimulationConfig {
  lon: number; lat: number; heightM: number; radiusKm: number;
  durationMinutes: number; domain: 'national' | 'regional';
}
export interface SimulationResult {
  grid: TerrainGrid; finalDepth: Float64Array; maxSurface: Float32Array; maxDepth: Float32Array;
  ocean: Uint8Array; elapsedSec: number; steps: number;
}
export type SimulationProgress = { elapsedSec: number; totalSec: number; steps: number };
