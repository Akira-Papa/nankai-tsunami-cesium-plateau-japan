import type { SimulationResult, TerrainGrid } from './simulationTypes';

export function decodeDem(r:number,g:number,b:number):number {
  const n=r*65536+g*256+b;
  return n===8388608?NaN:(n>8388608?n-16777216:n)*.01;
}
export function tilePixel(lon:number,lat:number,z=13):[number,number] {
  const scale=256*2**z;
  return [(lon+180)/360*scale,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*scale];
}
/** No rescaling/interpolation of the RGB-encoded elevations. 404 tiles stay void; other failures stop calculation. */
export async function loadCoastalDem(lon:number,lat:number,signal:AbortSignal,onProgress:(n:number)=>void):Promise<TerrainGrid> {
  const step=.00025,width=481,height=481,west=lon-.06,south=lat-.06;
  const [left,bottom]=tilePixel(west-step/2,south-step/2);
  const [right,top]=tilePixel(west+(width-.5)*step,south+(height-.5)*step);
  const tiles=new Map<string,Uint8ClampedArray>();
  const jobs:[number,number][]=[];
  for(let y=Math.floor(top/256);y<=Math.floor(bottom/256);y++)for(let x=Math.floor(left/256);x<=Math.floor(right/256);x++)jobs.push([x,y]);
  let done=0,cursor=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(cursor<jobs.length){
      const [x,y]=jobs[cursor++];signal.throwIfAborted();
      const response=await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/13/${x}/${y}.png`,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
      if(response.status===404){const bytes=new Uint8ClampedArray(256*256*4);tiles.set(`${x}/${y}`,bytes);onProgress(++done/jobs.length);continue;}
      if(!response.ok)throw Error(`詳細標高を取得できません (${response.status})。別の沿岸へ移動して再試行してください`);
      const bitmap=await createImageBitmap(await response.blob(),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
      if(bitmap.width!==256||bitmap.height!==256){bitmap.close();throw Error('標高タイルの形状が不正です');}
      const canvas=new OffscreenCanvas(256,256),ctx=canvas.getContext('2d')!;
      ctx.drawImage(bitmap,0,0);bitmap.close();tiles.set(`${x}/${y}`,ctx.getImageData(0,0,256,256).data);onProgress(++done/jobs.length);
    }
  }));
  const elevation=new Float32Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const [px,py]=tilePixel(west+x*step,south+y*step);
    const ix=Math.floor(px),iy=Math.floor(py),bytes=tiles.get(`${Math.floor(ix/256)}/${Math.floor(iy/256)}`)!;
    const i=((iy%256)*256+ix%256)*4;
    elevation[y*width+x]=bytes[i+3]===255?decodeDem(bytes[i],bytes[i+1],bytes[i+2]):NaN;
  }
  signal.throwIfAborted();if(!elevation.some(Number.isFinite))throw Error('この範囲に陸上標高がありません。海岸へ移動してください');return {width,height,west,south,step,elevation};
}

function coarseIndex(r:SimulationResult,lon:number,lat:number):number|null {
  const g=r.grid,x=Math.round((lon-g.west)/g.step),y=Math.round((lat-g.south)/g.step);
  return x<0||y<0||x>=g.width||y>=g.height?null:y*g.width+x;
}
/** Nearest coarse coastal land center; only within the simulated domain. */
export function nearestCoast(r:SimulationResult,lon:number,lat:number):[number,number] {
  const g=r.grid;let best=Infinity,point:[number,number]|undefined;
  for(let y=1;y<g.height-1;y++)for(let x=1;x<g.width-1;x++){
    const i=y*g.width+x;if(r.ocean[i]||![i-1,i+1,i-g.width,i+g.width].some(j=>r.ocean[j]))continue;
    const cx=g.west+x*g.step,cy=g.south+y*g.step,d=((cx-lon)*Math.cos(lat*Math.PI/180))**2+(cy-lat)**2;
    if(d<best){best=d;point=[cx,cy];}
  }
  if(!point)throw Error('計算範囲に海岸を見つけられません');return point;
}

/** Static connected-water envelope, NOT a fine-grid hydrodynamic tsunami solver.
 * Only boundary-connected DEM voids overlapping coarse ocean seed the inferred sea.
 * Inland voids remain unknown. No diagonal passage through a terrain barrier.
 * Maxima at different times are combined; travel time/volume/run-up are not predicted.
 */
export function coastalEnvelope(grid:TerrainGrid,coarse:SimulationResult):SimulationResult {
  const {width:w,height:h,elevation:z}=grid,n=w*h;
  const valid=Uint8Array.from(z,(v,i)=>Number.isFinite(v)&&coarseIndex(coarse,grid.west+i%w*grid.step,grid.south+Math.floor(i/w)*grid.step)!==null?1:0);
  const ocean=new Uint8Array(n),queue=new Int32Array(n);let head=0,tail=0;
  const neighbors=(i:number)=>[...(i%w>0?[i-1]:[]),...(i%w<w-1?[i+1]:[]),...(i>=w?[i-w]:[]),...(i<n-w?[i+w]:[])];
  for(let i=0;i<n;i++)if((i<w||i>=n-w||i%w===0||i%w===w-1)&&!Number.isFinite(z[i])){
    const c=coarseIndex(coarse,grid.west+(i%w)*grid.step,grid.south+Math.floor(i/w)*grid.step);
    if(c!==null&&coarse.ocean[c]){ocean[i]=1;queue[tail++]=i;}
  }
  while(head<tail){const i=queue[head++];for(const j of neighbors(i))if(!ocean[j]&&!Number.isFinite(z[j])){ocean[j]=1;queue[tail++]=j;}}
  const levels=new Float32Array(n);levels.fill(-Infinity);
  const heap:{i:number;v:number}[]=[];
  function push(i:number,v:number){let k=heap.length;heap.push({i,v});while(k){const p=(k-1)>>1;if(heap[p].v>=v)break;heap[k]=heap[p];k=p;}heap[k]={i,v};}
  function pop(){const first=heap[0],last=heap.pop()!;if(heap.length){let k=0;while(k*2+1<heap.length){let c=k*2+1;if(c+1<heap.length&&heap[c+1].v>heap[c].v)c++;if(heap[c].v<=last.v)break;heap[k]=heap[c];k=c;}heap[k]=last;}return first;}
  // Apply a separately sampled offshore head at each inferred shoreline pixel.
  for(let i=0;i<n;i++)if(valid[i]&&neighbors(i).some(j=>ocean[j])){
    const lon=grid.west+i%w*grid.step,lat=grid.south+Math.floor(i/w)*grid.step;
    const g=coarse.grid,cx=Math.round((lon-g.west)/g.step),cy=Math.round((lat-g.south)/g.step);
    let distance=Infinity,level=0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const x=cx+dx,y=cy+dy;if(x<0||y<0||x>=g.width||y>=g.height)continue;const c=y*g.width+x;
      const d=(g.west+x*g.step-lon)**2+(g.south+y*g.step-lat)**2;
      if(coarse.ocean[c]&&d<distance&&d<=(1.5*g.step)**2){distance=d;level=Math.max(0,coarse.maxSurface[c]);}
    }
    if(level>.01&&level>z[i]){levels[i]=level;push(i,level);}
  }
  while(heap.length){const {i,v}=pop();if(v<levels[i])continue;for(const j of neighbors(i))if(valid[j]&&z[j]<v&&v>levels[j]){levels[j]=v;push(j,v);}}
  const maxDepth=new Float32Array(n),maxSurface=new Float32Array(n),finalDepth=new Float64Array(n);
  for(let i=0;i<n;i++)if(Number.isFinite(levels[i])){maxDepth[i]=Math.max(0,levels[i]-z[i]);maxSurface[i]=levels[i];finalDepth[i]=maxDepth[i];}
  return {grid,ocean,maxDepth,maxSurface,finalDepth,elapsedSec:coarse.elapsedSec,steps:coarse.steps};
}
