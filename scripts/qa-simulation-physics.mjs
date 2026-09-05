import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Runs the production solver modules against the exact published binary terrain.
// In-memory bundling leaves the application build and repository unchanged.
async function loadModule(path) {
  const bundle = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const { runSimulation } = await loadModule('src/simulationSolver.ts');
const { decodeTerrain, selectGrid } = await loadModule('src/simulationTerrain.ts');
const metadata = JSON.parse(await readFile('public/simulation/terrain.json', 'utf8'));
const buffer = await readFile('public/simulation/etopo1-japan-3min.bin');
const terrain = await decodeTerrain(metadata, Uint8Array.from(buffer).buffer);
const reports = [];
for (const domain of ['national', 'regional']) {
  const config = { lon: 134, lat: 32, heightM: 30, radiusKm: 100, durationMinutes: 120, domain };
  const grid = selectGrid(terrain, config), started = performance.now();
  const result = runSimulation(grid, config);
  const wallMs = performance.now() - started;
  let maxLand = 0, maxSea = 0, wetLand = 0;
  for (let i = 0; i < grid.elevation.length; i++) {
    assert(Number.isFinite(result.finalDepth[i]) && result.finalDepth[i] >= 0);
    maxLand = Math.max(maxLand, result.maxDepth[i]); maxSea = Math.max(maxSea, result.maxSurface[i]);
    if (!result.ocean[i] && result.maxDepth[i] > .01) wetLand++;
  }
  assert.equal(result.elapsedSec, 7200);
  assert(wetLand > 0);
  reports.push({ domain, cells: grid.elevation.length, steps: result.steps, wallMs: Math.round(wallMs), maxLand, maxSea, wetLand, finiteNonnegative: true });
}
console.log(JSON.stringify({ terrainSha256: metadata.sha256, config: { lon: 134, lat: 32, heightM: 30, radiusKm: 100, durationMinutes: 120 }, reports }, null, 2));
