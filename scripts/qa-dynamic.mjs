import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/funakoshiakira/workspace/mirror-app/node_modules/@playwright/test');
const base=process.env.QA_BASE_URL||'http://127.0.0.1:5291';
const out=resolve('docs/dynamic-simulation/evidence',process.env.QA_RUN||'cycle-1');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const report={base,started:new Date().toISOString(),checks:[],pageErrors:[]};
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>report.pageErrors.push(String(e)));
const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
const check=async(name,fn)=>{const start=Date.now();try{const detail=await fn();report.checks.push({name,status:'passed',ms:Date.now()-start,detail});}catch(e){report.checks.push({name,status:'failed',error:String(e)});}};
const boot=async(p=page)=>{await p.goto(base,{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>!!window.app?.simulation,undefined,{timeout:60000});};
const range=async(id,value,p=page)=>{await p.locator('#'+id).fill(String(value));await p.locator('#'+id).dispatchEvent('input');};
const done=async(p=page)=>{await p.waitForFunction(()=>!!window.app.simulation.result || document.querySelector('#simulationStatus').textContent.includes('計算できません'),undefined,{timeout:180000});const s=await p.locator('#simulationStatus').innerText();assert(!s.includes('計算できません'),s);return s;};
try{
 await check('起動・公式表示を維持',async()=>{await boot();assert(await page.locator('#caseSelect').isVisible(),'公式未表示');return page.evaluate(()=>window.app.manifest.cases.length);});
 await check('全国の実地形をWorkerで動的計算',async()=>{
  await page.locator('#simulationModeCustom').check();await range('simulationDuration',5);const start=Date.now();const status=await done();
  assert(await page.locator('#shareButton').isDisabled(),'未対応共有が有効');
  const data=await page.evaluate(()=>{const r=window.app.simulation.result;return{width:r.grid.width,height:r.grid.height,steps:r.steps,elapsed:r.elapsedSec,maxSea:Math.max(...r.maxSurface),finite:r.finalDepth.every(Number.isFinite),landWet:Array.from(r.maxDepth).filter(x=>x>.01).length};});
  assert(data.width===281&&data.height===221&&data.elapsed===300&&data.finite,'national grid/worker failure');await page.waitForFunction(()=>window.viewer.imageryLayers.length===2);await page.waitForTimeout(1500);await page.screenshot({path:out+'/national.png',fullPage:true});return{...data,wallMs:Date.now()-start,status};
 });
 await check('高さ変更で旧結果消去・再計算',async()=>{
  const before=await page.evaluate(()=>Math.max(...window.app.simulation.result.maxSurface));
  await range('simulationHeight',10);
  assert(await page.evaluate(()=>!window.app.simulation.result),'stale result');await done();
  const after=await page.evaluate(()=>Math.max(...window.app.simulation.result.maxSurface));assert(after>before*1.5,'height change has no effect');return{before,after};
 });
 await check('ピン指定・地域計算・地点照会',async()=>{
  await page.locator('#simulationDomain').selectOption('regional');
  await page.locator('#simulationPick').click();
  // Feed the same geographical picking path used by the Cesium click handler; real screen pick is checked separately.
  await page.evaluate(()=>window.app.simulation.handleClick(136,32));await done();
  const config=await page.evaluate(()=>window.app.simulation.config);assert(config.lon===136&&config.lat===32,'pin not applied');
  await page.locator('#simulationInspect').click();await page.evaluate(()=>window.app.simulation.handleClick(136,32));const text=await page.locator('#pointReadout').innerText();assert(/水位|海上|海面/.test(text),'ocean readout missing');
  await page.evaluate(()=>window.app.simulation.handleClick(140,40));assert(/範囲外|未計算/.test(await page.locator('#pointReadout').innerText()),'outside not unknown');
  await page.screenshot({path:out+'/regional.png',fullPage:true});return{config,readout:text};
 });
 await check('長時間・高い津波で陸上浸水色と深さを照会',async()=>{
  await range('simulationHeight',30);await range('simulationRadius',100);await range('simulationDuration',120);const start=Date.now();await done();
  const value=await page.evaluate(()=>{const r=window.app.simulation.result;let index=0;for(let i=0;i<r.maxDepth.length;i++)if(r.maxDepth[i]>r.maxDepth[index])index=i;const lon=r.grid.west+(index%r.grid.width)*r.grid.step;const lat=r.grid.south+Math.floor(index/r.grid.width)*r.grid.step;window.app.simulation.handleClick(lon,lat);return{depth:r.maxDepth[index],ocean:r.ocean[index],lon,lat,steps:r.steps};});
  assert(value.depth>.01&&value.ocean===0,'no wet land for 30m/120min');assert(/地盤から/.test(await page.locator('#pointReadout').innerText()),'wrong depth datum');await page.waitForFunction(()=>window.viewer.imageryLayers.length===2);await page.evaluate(()=>{const v=window.viewer;v.camera.setView({destination:v.scene.globe.ellipsoid.cartographicToCartesian({longitude:134.5*Math.PI/180,latitude:33.5*Math.PI/180,height:600000}),orientation:{heading:0,pitch:-Math.PI/2,roll:0}});});await page.waitForTimeout(2000);await page.screenshot({path:out+'/land-inundation.png',fullPage:true});return{...value,wallMs:Date.now()-start};
 });
 await check('実画面クリックで海上ピンを移動',async()=>{
  await page.evaluate(()=>{const v=window.viewer;v.camera.setView({destination:v.scene.globe.ellipsoid.cartographicToCartesian({longitude:134*Math.PI/180,latitude:32*Math.PI/180,height:500000}),orientation:{heading:0,pitch:-Math.PI/2,roll:0}});});
  await range('simulationDuration',5);await page.locator('#simulationPick').click();await page.waitForTimeout(500);
  const box=await page.locator('#cesiumContainer canvas').first().boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await done();
  const c=await page.evaluate(()=>window.app.simulation.config);assert(Math.abs(c.lon-134)<.01&&Math.abs(c.lat-32)<.01,'actual mouse did not set source');return c;
 });
 await check('計算中止と旧Worker結果の破棄',async()=>{
  await range('simulationDuration',120);await page.waitForTimeout(800);await page.locator('#simulationCancel').click();await page.waitForTimeout(1500);
  assert(await page.evaluate(()=>!window.app.simulation.result&&!window.app.simulation.running),'result after cancel');return page.locator('#simulationStatus').innerText();
 });
 await check('無効な座標は旧結果を残さない',async()=>{
  await page.locator('#simulationLon').fill('200');await page.locator('#simulationLon').dispatchEvent('input');await page.waitForTimeout(850);
  assert(await page.evaluate(()=>!window.app.simulation.result),'invalid coordinate stale');assert(/計算できません/.test(await page.locator('#simulationStatus').innerText()),'invalid coordinates accepted');return page.locator('#simulationStatus').innerText();
 });
 await check('陸上波源を拒否・再試行で回復',async()=>{
  await page.locator('#simulationLon').fill('138');await page.locator('#simulationLat').fill('36');await range('simulationDuration',5);await page.waitForFunction(()=>document.querySelector('#simulationStatus').textContent.includes('計算できません'),undefined,{timeout:30000});
  assert(await page.evaluate(()=>!window.app.simulation.result),'land source accepted');
  await page.locator('#simulationLon').fill('134');await page.locator('#simulationLat').fill('32');await done();return page.locator('#simulationStatus').innerText();
 });
 await check('描画失敗を完了と誤表示しない',async()=>{
  await page.evaluate(()=>{const layers=window.viewer.imageryLayers;window.qaRestoreAdd=()=>{layers.add=window.qaOriginalAdd;};window.qaOriginalAdd=layers.add;layers.add=()=>{throw Error('QA intentional rendering failure');};});
  try{await page.locator('#simulationRun').click();await page.waitForFunction(()=>document.querySelector('#simulationStatus').textContent.includes('計算できません'),undefined,{timeout:30000});assert(await page.evaluate(()=>!window.app.simulation.result),'render failure retained result');}
  finally{await page.evaluate(()=>window.qaRestoreAdd());}
  await page.locator('#simulationRun').click();return done();
 });
 await check('公式モード復帰・独自レイヤー破棄',async()=>{
  await page.locator('#simulationModeOfficial').check();await page.evaluate(()=>window.app.refresh());
  assert(await page.locator('#caseSelect').isVisible(),'official controls hidden');assert(await page.evaluate(()=>!window.app.simulation.result&&!window.app.simulation.active),'simulation remains');return page.evaluate(()=>({cells:window.app.cells.length,imagery:window.viewer.imageryLayers.length}));
 });
 const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});mobile.on('pageerror',e=>report.pageErrors.push(String(e)));
 await check('モバイル操作・横溢れなし',async()=>{await boot(mobile);await mobile.locator('#simulationModeCustom').check();await range('simulationDuration',5,mobile);await mobile.locator('#simulationDomain').selectOption('regional');await done(mobile);await mobile.locator('#simulationHeight').scrollIntoViewIfNeeded();assert(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow');await mobile.screenshot({path:out+'/mobile.png',fullPage:true});await mobile.locator('#panelToggle').click();await mobile.screenshot({path:out+'/mobile-map.png',fullPage:true});return{width:390};});
 const failure=await browser.newPage({viewport:{width:1440,height:1000}});failure.on('pageerror',e=>report.pageErrors.push(String(e)));
 await check('数値地形取得失敗・再試行',async()=>{
  await failure.route('**/simulation/terrain.json',r=>r.fulfill({status:503,body:'intentional QA outage'}));await boot(failure);await failure.locator('#simulationModeCustom').check();
  await failure.waitForFunction(()=>document.querySelector('#simulationStatus').textContent.includes('計算できません'),undefined,{timeout:30000});assert(await failure.evaluate(()=>!window.app.simulation.result),'failed terrain has result');
  await failure.unroute('**/simulation/terrain.json');await range('simulationDuration',5,failure);await failure.locator('#simulationRun').click();return done(failure);
 });
}finally{report.finished=new Date().toISOString();await browser.close();await writeFile(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.pageErrors.length||report.checks.some(c=>c.status==='failed'))process.exitCode=1;}
