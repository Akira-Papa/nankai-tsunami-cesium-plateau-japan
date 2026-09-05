import { describe,it,expect,vi,afterEach } from 'vitest';
import { decodeCells,intersects } from './inundationData';
afterEach(()=>vi.unstubAllGlobals());
describe('inundation data integrity',()=>{
 it('retains unavailable arrival without converting to zero',()=>{
  expect(decodeCells([[136,35,2.5,null,40]],100)[0]).toEqual({lon:136,lat:35,depthM:2.5,arrivalSec:null,sizeM:100,sampleCount:40});
 });
 it('rejects negative arrival sentinel and invalid depth',()=>{
  expect(()=>decodeCells([[136,35,2,-9999]],100)).toThrow();
  expect(()=>decodeCells([[136,35,NaN,null]],100)).toThrow();
  expect(()=>decodeCells([[136,35,0,null]],100)).toThrow();
 });
 it('handles viewport overlap including a cell margin',()=>{
  expect(intersects([135,34,136,35],[136,35,137,36])).toBe(true);
  expect(intersects([135,34,136,35],[137,35,138,36])).toBe(false);
  expect(intersects([135,34,136,35],[136.001,35,138,36],.002)).toBe(true);
 });
});
describe('view request failures and LOD',()=>{
 it('does not synthesize data for unavailable cases',async()=>{
  vi.resetModules(); const {loadView}=await import('./inundationData');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,cases:[]})}));
  await expect(loadView('11',[130,30,140,40])).rejects.toThrow('未収録');
 });
 it('throws on tile error instead of returning an empty safe-looking area',async()=>{
  vi.resetModules();const {loadView}=await import('./inundationData');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({version:1,cases:[{id:'1',label:'case1',bounds:[130,30,140,40],available:true,levels:[{resolutionM:100,tiles:[{path:'1/100/136_35.json',bounds:[136,35,136,35],count:1}]}]}]})}).mockResolvedValueOnce({ok:false,status:503}));
  await expect(loadView('1',[135,34,137,36],100)).rejects.toThrow('503');
 });
 it('uses coarser data when detailed tile count exceeds limit',async()=>{
  vi.resetModules();const {loadView}=await import('./inundationData');
  const request=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({version:1,cases:[{id:'1',label:'case1',bounds:[130,30,140,40],available:true,levels:[{resolutionM:100,tiles:[{path:'1/100/136_35.json',bounds:[136,35,136,35],count:30000}]},{resolutionM:500,tiles:[{path:'1/500/136_35.json',bounds:[136,35,136,35],count:1}]}]}]})}).mockResolvedValueOnce({ok:true,json:async()=>[[136,35,2,60,100]]});
  vi.stubGlobal('fetch',request);const r=await loadView('1',[135,34,137,36],100);expect(r.resolutionM).toBe(500);expect(r.cells).toHaveLength(1);expect(request).toHaveBeenLastCalledWith('/inundation/1/500/136_35.json',expect.any(Object));
 });
});
describe('manifest boundary',()=>{
 it('rejects untrusted tile paths and nonfinite cell dimensions',async()=>{
  const {validateManifest}=await import('./inundationData');
  expect(()=>validateManifest({version:1,cases:[{id:'1',label:'case1',available:true,bounds:[130,30,140,40],levels:[{resolutionM:100,tiles:[{path:'../private.json',bounds:[130,30,140,40],count:1}]}]}]})).toThrow('タイル');
  expect(()=>decodeCells([[136,35,2,null]],Infinity)).toThrow('解像度');
 });
});
