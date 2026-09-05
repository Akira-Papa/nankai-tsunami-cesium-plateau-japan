import * as Cesium from 'cesium';
import {loadCoastalDem,coastalEnvelope,nearestCoast} from './coastalDetail';
import {createSimulationLayer,simulationCellIndex} from './simulationLayer';
import type {SimulationResult,SimulationConfig} from './simulationTypes';

export function createCoastalController(viewer:Cesium.Viewer,onFootprint:(bounds:[number,number,number,number]|undefined)=>void) {
  const layer=createSimulationLayer(viewer,{detail:true});
  const note=document.querySelector<HTMLElement>('#coastalStatus')!;
  const overlay=document.createElement('div');overlay.id='coastalLoading';overlay.hidden=true;overlay.className='coastal-loading';overlay.setAttribute('role','status');document.body.append(overlay);
  let coarse:SimulationResult|undefined,config:SimulationConfig|undefined,result:SimulationResult|undefined;
  let abort:AbortController|undefined,epoch=0,target:[number,number]|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  function clear(){epoch++;abort?.abort();abort=undefined;clearTimeout(timer);coarse=undefined;result=undefined;layer.clear();onFootprint(undefined);overlay.hidden=true;note.textContent='波源の計算後、海岸を詳細計算します。';}
  function center():[number,number]|undefined {
    const canvas=viewer.canvas,ray=viewer.camera.getPickRay(new Cesium.Cartesian2(canvas.clientWidth/2,canvas.clientHeight/2));
    const p=ray&&viewer.scene.globe.pick(ray,viewer.scene);if(!p)return;
    const c=Cesium.Cartographic.fromCartesian(p);return [Cesium.Math.toDegrees(c.longitude),Cesium.Math.toDegrees(c.latitude)];
  }
  async function calculate(point:[number,number]){
    if(!coarse)return;
    const source=coarse,id=++epoch;abort?.abort();const controller=new AbortController();abort=controller;
    result=undefined;layer.clear();target=point;onFootprint([point[0]-.060125,point[1]-.060125,point[0]+.060125,point[1]+.060125]);overlay.hidden=false;overlay.textContent='沿岸の詳細標高を取得中…';note.textContent=overlay.textContent;
    try{
      const grid=await loadCoastalDem(...point,controller.signal,p=>{if(id===epoch){overlay.textContent=`沿岸の詳細標高を取得中… ${Math.round(p*100)}%`;note.textContent=overlay.textContent;}});
      if(id!==epoch)return;
      overlay.textContent='標高と海からの接続経路を計算中…';
      await new Promise(resolve=>setTimeout(resolve,0));if(id!==epoch)return;
      const next=coastalEnvelope(grid,source);
      await layer.setResult(next);if(id!==epoch)return;result=next;
      let wet=0,max=0,known=0,edgeWet=false;for(let i=0;i<grid.elevation.length;i++){if(Number.isFinite(grid.elevation[i]))known++;if(next.maxDepth[i]>.01){wet++;max=Math.max(max,next.maxDepth[i]);if(i<grid.width||i>=grid.width*(grid.height-1)||i%grid.width===0||i%grid.width===grid.width-1)edgeWet=true;}}
      note.textContent=`沿岸詳細完了：${point[0].toFixed(3)}°E / ${point[1].toFixed(3)}°N。約28m間隔・481×481セル、標高取得 ${known.toLocaleString()}セル、着色 ${wet.toLocaleString()}セル、最大浸水深 ${max.toFixed(2)}m。${edgeWet?'着色が枠の端に達しています。到達の終端は未確定です。':''}黄色〜紫がピンからの地形接続性試算。枠の外・欠損は未計算。DEMの欠損と粗い海域判定から海岸線を推定。最大水位を用いた静的試算で、波の勢い・流量・防潮堤・到達時刻は再現しません。`;
      overlay.hidden=true;
    }catch(error){if(id!==epoch)return;controller.abort();result=undefined;layer.clear();overlay.hidden=true;note.textContent=`沿岸詳細は未計算：${error instanceof Error?error.message:String(error)}`;}
  }
  document.querySelector('#coastalRecalculate')!.addEventListener('click',()=>{
    if(!coarse){note.textContent='先に波源の計算を完了してください。';return;}
    const p=center();if(p)void calculate(p);
  });
  document.querySelector('#coastalFly')!.addEventListener('click',()=>{if(target)viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(...target,21000),orientation:{heading:0,pitch:-Math.PI/2,roll:0},duration:.6});});
  viewer.camera.moveEnd.addEventListener(()=>{
    clearTimeout(timer);if(!coarse||viewer.camera.positionCartographic.height>80000)return;
    const point=center();if(!point)return;
    if(target&&Math.abs(target[0]-point[0])<.015&&Math.abs(target[1]-point[1])<.015)return;
    // Immediately remove the old result while the camera settles.
    epoch++;abort?.abort();result=undefined;layer.clear();overlay.hidden=false;overlay.textContent='表示中の沿岸を再計算します…';
    timer=setTimeout(()=>{void calculate(point);},400);
  });
  return {clear,get result(){return result;},get target(){return target;},get busy(){return !overlay.hidden;},
    setCoarse(next:SimulationResult,c:SimulationConfig){clear();coarse=next;config=c;const point=viewer.camera.positionCartographic.height<80000?center():undefined;try{void calculate(point??nearestCoast(next,config.lon,config.lat));}catch(error){note.textContent=String(error);}},
    inspect(lon:number,lat:number):string|undefined{
      if(!result)return;
      const i=simulationCellIndex(result.grid,lon,lat);if(i===null)return;
      const z=result.grid.elevation[i];if(!Number.isFinite(z))return '詳細標高なし（海面または欠損）。この地点の浸水深は未計算です。';
      const d=result.maxDepth[i];return `詳細地形の標高 ${z.toFixed(2)}m ／ 試算浸水深 ${d.toFixed(2)}m（地盤から）${d>.01?` ／ 試算水面標高 ${result.maxSurface[i].toFixed(2)}m`:''}。約28m間隔。ピンからの沖合水位と海への接続性による静的試算で、実際の到達・安全を判定できません。`;
    }
  };
}
