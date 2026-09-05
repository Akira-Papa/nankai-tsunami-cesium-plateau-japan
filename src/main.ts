import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import { loadAll, findMunicipality, type AppData, type BBox } from './data';
import { TERRAIN_URL } from './tilesets';
import { createTilesetManager, type TilesetManager, type PlateauTilesetEntry } from './tilesetManager';
import { applySceneQuality, QUALITY_PROFILES } from './quality';
import { initExplorerUi, type ExplorerState } from './explorerUi';
import { loadManifest, loadView, type InundationCell } from './inundationData';
import { createInundationLayer, cellBounds } from './inundationLayer';
import { readShare, shareSearch, type CameraState } from './explorerState';

Cesium.Ion.defaultAccessToken = '';
const degrees = Cesium.Math.toDegrees;
let ui: ReturnType<typeof initExplorerUi> | undefined;
let viewer: Cesium.Viewer;
let layer: ReturnType<typeof createInundationLayer>;
let buildings: TilesetManager | undefined;
let data: AppData;
let manifest: Awaited<ReturnType<typeof loadManifest>>;
let current: ExplorerState;
let cells: InundationCell[] = [];
let resolutionM = 2500;
let viewEpoch = 0, pickEpoch = 0, refreshTimer = 0;
let terrainState = '地形を読込中';
let dataStatus = '計算データを読込中';
let startupWarning = '';
let marker: Cesium.Entity | undefined;
let lastPoint: {lon:number;lat:number} | undefined;

function status() {
  const b = buildings?.stats();
  ui?.setStatus(`${startupWarning}${dataStatus} ／ ${terrainState} ／ 建物 ${b?.loaded ?? 0}件${b?.loading ? '（読込中）' : ''}`);
}
function fail(message: string) {
  if (ui) ui.setStatus(message);
  else { const el=document.getElementById('webglFallback'); const detail=document.getElementById('webglFallbackDetail'); if(el)el.hidden=false; if(detail)detail.textContent=message; }
}
function imagery(photo: boolean) {
  const provider = new Cesium.UrlTemplateImageryProvider({url:'https://cyberjapandata.gsi.go.jp/xyz/{style}/{z}/{x}/{y}.{ext}',customTags:{style:(_p:unknown,_x:number,_y:number,z:number)=>z<2?'std':photo?'seamlessphoto':'pale',ext:(_p:unknown,_x:number,_y:number,z:number)=>z>=2&&photo?'jpg':'png'},rectangle:Cesium.Rectangle.fromDegrees(122,20,154,46),maximumLevel:18,credit:new Cesium.Credit('<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',true)});
  provider.errorEvent.addEventListener(() => { terrainState='背景地図の一部を取得できません（再移動で再試行）'; status(); });
  return new Cesium.ImageryLayer(provider);
}
function cameraState(): CameraState {
  const p=viewer.camera.positionCartographic;
  return {lon:degrees(p.longitude),lat:degrees(p.latitude),height:p.height,heading:degrees(viewer.camera.heading),pitch:degrees(viewer.camera.pitch)};
}
function setCamera(c: CameraState, duration=0) {
  viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(c.lon,c.lat,c.height),orientation:{heading:Cesium.Math.toRadians(c.heading),pitch:Cesium.Math.toRadians(c.pitch),roll:0},duration});
}
function overview() { setCamera({lon:137,lat:35.5,height:2600000,heading:0,pitch:-90},1); }
function bbox(): BBox {
  const r=viewer.camera.computeViewRectangle();
  if(!r) return [122,20,154,46];
  if(r.east<r.west) return [122,20,154,46];
  return [degrees(r.west),degrees(r.south),degrees(r.east),degrees(r.north)];
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer=window.setTimeout(() => { void refresh(); buildings?.update(); },250);
}
async function refresh() {
  if(!current || !current.caseId) {dataStatus='浸水データ未読込：再試行ボタンを押してください';status();return;}
  clearTimeout(refreshTimer);
  const epoch=++viewEpoch;
  const box=bbox();
  const span=Math.max(box[2]-box[0],box[3]-box[1]);
  const level=span>4?2500:span>.6?500:100;
  dataStatus='計算データを読込中'; status();
  try {
    const result=await loadView(current.caseId,box,level);
    if(epoch!==viewEpoch) return;
    const unchanged=resolutionM===result.resolutionM&&cells.length===result.cells.length&&cells.every((c,i)=>c===result.cells[i]);
    cells=result.cells; resolutionM=result.resolutionM;
    if(!unchanged)layer.setCells(cells); layer.setDisplay(current);
    dataStatus=cells.length ? `${cells.length.toLocaleString()}集約セル・${resolutionM}m表示${result.truncated?'（表示上限あり）':''}`:'この表示範囲に収録セルなし（安全を意味しません）';
    ui?.setDataNote(`内閣府2025・${manifest.cases.find(c=>c.id===current.caseId)?.label ?? current.caseId}。${resolutionM}m集約表示。色は集約内の最大浸水深、時間は最早1cm到達。両者は同じ元セルとは限りません。着色セル全体が浸水する意味ではありません。地形・建物の細かさは計算解像度を示しません。`);
    status(); viewer.scene.requestRender();
  } catch(error) {
    if(epoch!==viewEpoch) return;
    layer.clear(); cells=[];
    dataStatus=`計算データ取得失敗：${error instanceof Error?error.message:String(error)}。地図を移動するかケースを選び直して再試行`; status();
  }
}
function clearPick() { ++pickEpoch; lastPoint=undefined; if(marker) marker.show=false; ui?.setReadout('地図上をクリックすると、その周辺の集約浸水データを確認できます。'); }
function apply(s: ExplorerState) {
  const prev=current; current={...s};
  if(!prev || prev.caseId!==s.caseId) { ++viewEpoch; layer.clear(); cells=[]; clearPick(); void refresh(); }
  if(!prev || prev.photo!==s.photo) { const old=viewer.imageryLayers.get(0); if(old)viewer.imageryLayers.remove(old,true); viewer.imageryLayers.add(imagery(s.photo),0); }
  if(!prev || prev.lite!==s.lite) applySceneQuality(viewer,QUALITY_PROFILES[s.lite?'lite':'standard']);
  buildings?.setEnabled(s.buildings && !s.lite);
  layer.setDisplay(s);
  if(lastPoint && prev && (prev.minutes!==s.minutes||prev.mode!==s.mode)) void inspectPoint(lastPoint.lon,lastPoint.lat);
  viewer.scene.requestRender();
}
function locate(code:string) {
  if(code==='all'||code==='japan'){overview();return;}
  const m=findMunicipality(data.municipalities,code); if(!m)return;
  clearPick();
  // A stable city scale makes the 100m display useful without loading an entire prefecture.
  const coastalCenters: Record<string,[number,number]>={'39201':[133.55,33.55],'23100':[136.88,35.10],'22100':[138.48,35.01],'27100':[135.45,34.65]};
  const [lon,lat]=coastalCenters[code]??[m.lon,m.lat];
  setCamera({lon,lat:lat-.065,height:14000,heading:0,pitch:-55},1.2);
}
async function inspectPoint(lon:number,lat:number) {
  const epoch=++pickEpoch, caseId=current.caseId;
  lastPoint={lon,lat};
  ui?.setReadout(`${lat.toFixed(5)}, ${lon.toFixed(5)}：周辺100m集約データを読込中`);
  try {
    const result=await loadView(caseId,[lon-.003,lat-.003,lon+.003,lat+.003],100);
    if(epoch!==pickEpoch||caseId!==current.caseId)return;
    const candidates=result.cells.filter(c => {const [w,s,e,n]=cellBounds(c);return lon>=w&&lon<e&&lat>=s&&lat<n;});
    candidates.sort((a,b)=>Math.hypot(a.lon-lon,a.lat-lat)-Math.hypot(b.lon-lon,b.lat-lat));
    const c=candidates[0];
    if(!c) {ui?.setReadout(`${lat.toFixed(5)}, ${lon.toFixed(5)}｜収録セルなし。浸水しない・安全とは判断できません。`);return;}
    const arrival=c.arrivalSec===null?'到達時間未収録':`${(c.arrivalSec/60).toFixed(1)}分（1cmへ最早到達）`;
    const at=current.mode==='arrival'?`｜指定${current.minutes}分時点：${c.arrivalSec===null?'判定不可':c.arrivalSec<=current.minutes*60?'到達済み':'まだ到達記録なし'}`:'';
    ui?.setReadout(`${lat.toFixed(5)}, ${lon.toFixed(5)}｜周辺${c.sizeM}m集約の最大浸水深 ${c.depthM.toFixed(2)}m｜${arrival}${at}。最大深さは指定時刻の水深ではありません。出典：内閣府2025／${manifest.cases.find(x=>x.id===caseId)?.label??caseId}`);
  } catch {if(epoch===pickEpoch)ui?.setReadout('地点データの取得失敗。地点を選び直して再試行してください。');}
}

async function boot() {
  viewer=new Cesium.Viewer('cesiumContainer',{baseLayer:imagery(false),terrainProvider:new Cesium.EllipsoidTerrainProvider(),animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,requestRenderMode:true,maximumRenderTimeChange:Infinity,shadows:false,msaaSamples:1});
  viewer.scene.globe.depthTestAgainstTerrain=true;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance=100;
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  viewer.scene.renderError.addEventListener((_scene:unknown,e:unknown)=>fail(`3D描画エラー：${String(e)}。再読み込みしてください。`));
  layer=createInundationLayer(viewer);
  overview();
  const initialResults=await Promise.allSettled([loadAll(),loadManifest()]);
  if(initialResults[0].status==='fulfilled')data=initialResults[0].value;
  else {startupWarning='自治体・建物データ取得失敗。再試行してください ／ '; data={municipalities:{generated:'',source:{n03:'',license:''},prefectures:[],municipalities:[]},registry:{generated:'',source:'',tilesets:[]},coastal:{type:'FeatureCollection',features:[]},tsunami:{generated:'',source:{'2025':'','2012':'',license:''},unit:'',cases:[],rows:[]},isFixture:false};}
  if(initialResults[1].status==='fulfilled')manifest=initialResults[1].value;
  else {startupWarning+='浸水データ一覧取得失敗。地図閲覧は可能です ／ ';manifest={version:1,source:'',sourceUrl:'',licenseUrl:'',originalResolutionM:10,coordinateSystem:'',depthDefinition:'',arrivalDefinition:'',aggregation:'',cases:[]};}
  const shared=readShare(location.search,manifest.cases.filter(c=>c.available).map(c=>c.id));
  ui=initExplorerUi({municipalities:data.municipalities.municipalities,cases:manifest.cases.filter(c=>c.available),initial:shared.state},{
    onChange:apply,onCity:locate,onOverview:overview,
    onView(top){const c=cameraState();setCamera({...c,pitch:top?-90:-50},.5);},
    async onShare(){
      const url=new URL(location.href); url.search=shareSearch(current,cameraState());url.hash='';
      history.replaceState(null,'',url);
      try{await navigator.clipboard.writeText(url.href);ui?.setStatus('現在の視点・ケース・表示条件の共有URLをコピーしました');}
      catch{ui?.setReadout(`共有URL（アドレス欄からもコピーできます）：${url.href}`);}
    },
  });
  if(startupWarning)ui.setDataNote('計算済みデータの取得に失敗しました。未取得の状態では浸水の有無を判断できません。データを再試行してください。');
  document.getElementById('retryData')?.addEventListener('click',()=>{if(startupWarning)location.reload();else void refresh();});
  buildings=createTilesetManager(viewer,{registry:{generated:data.registry.generated,source:data.registry.source,tilesets:data.registry.tilesets.filter(t=>t.lod===1||t.lod===2).map(t=>({...t,lod:t.lod as 1|2,http_status:t.http_status??undefined})) as PlateauTilesetEntry[]},inundationShading:false,maxConcurrent:2,maxLoaded:3,lruSize:1,maxCameraHeight:45000,lod2:false,onStatus:status});
  // Buildings preserve their source appearance; no uniform water shading.
  apply(ui.getState());
  if(shared.camera)setCamera(shared.camera);
  viewer.camera.moveEnd.addEventListener(()=>{
    const top=degrees(viewer.camera.pitch)<-75;document.getElementById('topViewButton')?.setAttribute('aria-pressed',String(top));document.getElementById('tiltViewButton')?.setAttribute('aria-pressed',String(!top));scheduleRefresh();
  });
  viewer.camera.moveStart.addEventListener(()=>{++viewEpoch;});
  const handler=new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((e:Cesium.ScreenSpaceEventHandler.PositionedEvent)=>{
    const ray=viewer.camera.getPickRay(e.position);const cart=ray?viewer.scene.globe.pick(ray,viewer.scene):undefined;
    if(!cart)return;const c=Cesium.Cartographic.fromCartesian(cart);
    if(!marker)marker=viewer.entities.add({position:cart,point:{pixelSize:11,color:Cesium.Color.WHITE,outlineColor:Cesium.Color.BLACK,outlineWidth:2,disableDepthTestDistance:Infinity}});
    marker.position=new Cesium.ConstantPositionProperty(cart);marker.show=true;
    void inspectPoint(degrees(c.longitude),degrees(c.latitude));viewer.scene.requestRender();
  },Cesium.ScreenSpaceEventType.LEFT_CLICK);
  Object.assign(window,{viewer,app:{viewer,ui,locate,overview,inspectPoint,refresh,get cells(){return cells;},get manifest(){return manifest;},get state(){return current;},get resolutionM(){return resolutionM;},get layerStats(){return layer.stats();}}});
  try {
    viewer.terrainProvider=await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL,{requestVertexNormals:false,credit:new Cesium.Credit('PLATEAU 地形・国土地理院',true)});
    terrainState='3D地形'; viewer.terrainProvider.errorEvent.addEventListener(()=>{terrainState='地形の一部を取得できません';status();});
  } catch {terrainState='地形取得失敗：平坦な地球で表示（標高なし）';}
  status();scheduleRefresh();viewer.scene.requestRender();
}
void boot().catch(e=>{console.error(e);fail(`起動に失敗しました：${e instanceof Error?e.message:String(e)}。再読み込みしてください。`);});
