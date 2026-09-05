/// <reference lib="webworker" />
import { runSimulation } from './simulationSolver';
import type { SimulationConfig, TerrainGrid } from './simulationTypes';
self.onmessage = (event: MessageEvent<{ type: 'start'; id: number; grid: TerrainGrid; config: SimulationConfig }>) => {
  const { type, id, grid, config } = event.data;
  if (type !== 'start') return;
  try {
    const result = runSimulation(grid, config, progress => self.postMessage({ type: 'progress', id, progress }));
    self.postMessage({ type: 'result', id, result }, [result.finalDepth.buffer, result.maxSurface.buffer, result.maxDepth.buffer, result.ocean.buffer, result.grid.elevation.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : '数値計算に失敗しました。' });
  }
};
