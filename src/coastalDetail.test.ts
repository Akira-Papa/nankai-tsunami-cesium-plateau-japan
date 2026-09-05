import {describe,it,expect} from 'vitest';
import {coastalEnvelope,decodeDem,tilePixel} from './coastalDetail';
import type {SimulationResult,TerrainGrid} from './simulationTypes';
function fixture(level=4){
 const width=9,height=7;
 const grid:TerrainGrid={width,height,west:133,south:33,step:.001,elevation:Float32Array.from({length:width*height},(_,i)=>i%width<2?NaN:i%width===5?6:1)};
 const ocean=Uint8Array.from(grid.elevation,z=>Number.isNaN(z)?1:0);
 const coarse:SimulationResult={grid:{...grid,elevation:Float32Array.from(grid.elevation,z=>Number.isNaN(z)?-100:z)},ocean,maxSurface:Float32Array.from(ocean,v=>v?level:0),maxDepth:new Float32Array(width*height),finalDepth:new Float64Array(width*height),elapsedSec:1800,steps:1};return {grid,coarse};
}
describe('coastal static connected-water estimate',()=>{
 it('decodes positive, negative and missing DEM values without making voids zero',()=>{expect(decodeDem(0,1,244)).toBe(5);expect(decodeDem(255,255,156)).toBe(-1);expect(decodeDem(128,0,0)).toBeNaN();});
 it('projects longitude east and latitude north into XYZ pixels',()=>{expect(tilePixel(0,0,0)).toEqual([128,128]);expect(tilePixel(1,1)[0]).toBeGreaterThan(tilePixel(0,0)[0]);expect(tilePixel(1,1)[1]).toBeLessThan(tilePixel(0,0)[1]);});
 it('subtracts actual ground elevation from local sea head and stops at higher terrain',()=>{const {grid,coarse}=fixture();const r=coastalEnvelope(grid,coarse);expect(r.maxDepth[3*9+3]).toBe(3);expect(r.maxDepth[3*9+5]).toBe(0);expect(r.maxDepth[3*9+7]).toBe(0);});
 it('higher pin-derived water overtops a barrier and increases footprint',()=>{const a=fixture(4),b=fixture(8);const low=coastalEnvelope(a.grid,a.coarse),high=coastalEnvelope(b.grid,b.coarse);expect(high.maxDepth[3*9+7]).toBe(7);expect(high.maxDepth.filter(v=>v>0).length).toBeGreaterThan(low.maxDepth.filter(v=>v>0).length);});
 it('zero offshore response leaves all land dry including below sea level land',()=>{const {grid,coarse}=fixture(0);grid.elevation[3*9+3]=-2;expect(coastalEnvelope(grid,coarse).maxDepth.every(v=>v===0)).toBe(true);});
 it('does not seed isolated interior DEM voids as sea',()=>{const {grid,coarse}=fixture();grid.elevation[3*9+7]=NaN;const r=coastalEnvelope(grid,coarse);expect(r.ocean[3*9+7]).toBe(0);expect(r.maxDepth[3*9+6]).toBe(0);});
 it('does not make voids into zero-height terrain or color them',()=>{const {grid,coarse}=fixture();const r=coastalEnvelope(grid,coarse);expect(r.maxDepth[0]).toBe(0);expect(Number.isNaN(r.grid.elevation[0])).toBe(true);});
 it('50m forcing remains finite and yields depth relative to each elevation',()=>{const {grid,coarse}=fixture(50);const r=coastalEnvelope(grid,coarse);expect(r.maxDepth[3*9+5]).toBe(44);expect([...r.maxDepth].every(Number.isFinite)).toBe(true);});
 it('will not color land outside the parent simulation coverage',()=>{const {grid,coarse}=fixture(50);coarse.grid={...coarse.grid,width:5,elevation:new Float32Array(35)};coarse.ocean=Uint8Array.from({length:35},(_,i)=>i%5<2?1:0);coarse.maxSurface=new Float32Array(35).fill(50);const r=coastalEnvelope(grid,coarse);expect(r.maxDepth[3*9+7]).toBe(0);});
 it('only four-connected paths cross a barrier (no diagonal corner shortcuts)',()=>{const {grid,coarse}=fixture();grid.elevation.fill(9);for(let y=0;y<7;y++)grid.elevation[y*9]=NaN;grid.elevation[3*9+1]=1;grid.elevation[4*9+2]=1;const r=coastalEnvelope(grid,coarse);expect(r.maxDepth[3*9+1]).toBe(3);expect(r.maxDepth[4*9+2]).toBe(0);});
});
