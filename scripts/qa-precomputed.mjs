// Run against an already running dev/preview/production URL. Never mutates remote data.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', '@playwright/test', '/Users/funakoshiakira/workspace/mirror-app/node_modules/@playwright/test'].filter(Boolean)) {
  try { ({chromium} = require(candidate)); break; } catch { /* try installed dependency only */ }
}
if (!chromium) throw new Error('Playwright unavailable. Set PLAYWRIGHT_MODULE to an installed playwright or @playwright/test path.');
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4173';
const out = resolve(process.env.QA_EVIDENCE_DIR || 'docs/precomputed/evidence', process.env.QA_RUN || `run-${Date.now()}`);
await mkdir(out, {recursive:true});
const report = {base, started:new Date().toISOString(), checks:[], externalFailures:[], localFailures:[], pageErrors:[]};
const browser = await chromium.launch({headless:true, ...(process.env.CHROME_EXECUTABLE ? {executablePath:process.env.CHROME_EXECUTABLE} : {}), args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const assert = (condition,message) => {if (!condition) throw new Error(message);};
async function check(name, fn) {
  try { const detail=await fn(); report.checks.push({name,status:'passed',detail}); }
  catch(error) {report.checks.push({name,status:'failed',error:String(error)});}
}
function instrument(page) {
  page.on('pageerror', e=>report.pageErrors.push(String(e)));
  page.on('requestfailed', request => {
    const item={url:request.url(),failure:request.failure()?.errorText};
    (new URL(request.url()).origin === new URL(base).origin ? report.localFailures : report.externalFailures).push(item);
  });
}
async function ready(page, search='') {
  await page.goto(`${base}/${search}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window.app && window.app.manifest.cases.length>0, undefined, {timeout:60000});
}
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}}); instrument(page);
  let available=false;
  await check('desktop: local app boot and WebGL canvas', async()=>{
    await ready(page); available=true;
    const result=await page.evaluate(()=>({cases:window.app.manifest.cases.map(c=>c.id), canvas:document.querySelector('canvas')?.getBoundingClientRect().toJSON(), destroyed:window.app.viewer.isDestroyed()}));
    assert(result.canvas?.width>500 && result.canvas?.height>300 && !result.destroyed,'Cesium canvas unavailable');
    await page.screenshot({path:`${out}/desktop.png`,fullPage:true}); return result;
  });
  if(available) {
    await check('desktop: actual local inundation data loaded',async()=>{
      await page.evaluate(()=>window.app.refresh());
      await page.waitForFunction(()=>window.app.cells.length>0,undefined,{timeout:60000});
      return page.evaluate(()=>({count:window.app.cells.length,resolutionM:window.app.resolutionM,stats:window.app.layerStats,status:document.querySelector('#layerStatus').textContent}));
    });
    await check('four coastal cities: data, terrain and GPU batches', async()=>{
      const results=[];
      for(const code of ['23100','39201','22100','27100']) {
        await page.locator(`button[data-city="${code}"]`).click();
        await page.waitForTimeout(1700);
        await page.evaluate(()=>window.app.refresh());
        await page.waitForFunction(()=>window.app.cells.length>0&&window.app.layerStats.preparedBatches>0&&window.app.layerStats.pendingBatches===0,undefined,{timeout:45000});
        await page.waitForTimeout(350);
        await page.waitForFunction(()=>window.app.layerStats.pendingBatches===0&&window.app.layerStats.preparedBatches>0,undefined,{timeout:45000});
        results.push(await page.evaluate(()=>({count:window.app.cells.length,resolutionM:window.app.resolutionM,stats:window.app.layerStats,status:document.querySelector('#layerStatus').textContent})));
      }
      await page.screenshot({path:`${out}/coastal-city.png`,fullPage:true});
      return results;
    });
    await check('arrival: 0 minutes preserved and point inspection completes',async()=>{
      await page.locator('#modeArrival').check();
      await page.locator('#minutesSlider').fill('0'); await page.locator('#minutesSlider').dispatchEvent('input');
      assert(await page.evaluate(()=>window.app.state.minutes===0 && window.app.state.mode==='arrival'),'0 minutes lost');
      await page.evaluate(()=>window.app.inspectPoint(133.55,33.55));
      const text=await page.locator('#pointReadout').innerText();
      assert(/最大浸水深|収録セルなし/.test(text),'point result missing or failed'); return text;
    });
    await check('arrival playback: advances, stops, and stops at 720 minutes',async()=>{
      await page.locator('#playArrival').click();
      await page.waitForFunction(()=>window.app.state.minutes>0,undefined,{timeout:5000});
      await page.locator('#playArrival').click();
      const stopped=await page.evaluate(()=>window.app.state.minutes);
      await page.waitForTimeout(1000);
      assert(await page.evaluate(()=>window.app.state.minutes)===stopped,'playback keeps advancing after stop');
      await page.locator('#minutesSlider').fill('719'); await page.locator('#minutesSlider').dispatchEvent('input');
      await page.locator('#playArrival').click();
      await page.waitForFunction(()=>window.app.state.minutes===720 && document.querySelector('#playArrival').getAttribute('aria-pressed')==='false',undefined,{timeout:5000});
      await page.locator('#minutesSlider').fill('0'); await page.locator('#minutesSlider').dispatchEvent('input');
      return 'manual stop and 720-minute automatic stop verified';
    });
    await check('case change: point cleared and camera retained',async()=>{
      const ids=await page.evaluate(()=>window.app.manifest.cases.filter(c=>c.available).map(c=>c.id));
      assert(ids.length>=2,'Only one case: case-switch test requires at least 2 real cases');
      const before=await page.evaluate(()=>window.app.viewer.camera.positionCartographic.height);
      await page.locator('#caseSelect').selectOption(ids[1]);
      const state=await page.evaluate(()=>({id:window.app.state.caseId,height:window.app.viewer.camera.positionCartographic.height,point:document.querySelector('#pointReadout').textContent}));
      assert(state.id===ids[1] && Math.abs(state.height-before)<1,'case/camera mismatch');
      assert(!/最大浸水深 \d/.test(state.point),'stale point values'); return state;
    });
    await check('share URL restores display state on reload',async()=>{
      await page.locator('#shareButton').click();
      const url=page.url(); assert(url.includes('mode=arrival') && url.includes('min=0'),'share URL state missing');
      await page.reload({waitUntil:'domcontentloaded'}); await page.waitForFunction(()=>!!window.app,undefined,{timeout:60000});
      assert(await page.evaluate(()=>window.app.state.minutes===0&&window.app.state.mode==='arrival'),'shared state changed'); return url;
    });
  }
  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}); instrument(mobile);
  await check('mobile 390x844: controls and collapsed map',async()=>{
    await ready(mobile);
    const width=await mobile.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:innerWidth})); assert(width.scroll<=width.inner+1,'horizontal overflow');
    await mobile.locator('#panelToggle').click();
    assert(await mobile.locator('#panelToggle').getAttribute('aria-expanded')==='false','panel does not collapse');
    await mobile.screenshot({path:`${out}/mobile-collapsed.png`,fullPage:true});
    await mobile.locator('#panelToggle').click(); await mobile.locator('#muniSearch').fill('高知市');
    assert(await mobile.locator('#muniSelect option').count()>1,'municipality search failed');
    await mobile.screenshot({path:`${out}/mobile-controls.png`,fullPage:true}); return width;
  });
  const missing=await browser.newPage({viewport:{width:1440,height:1000}}); instrument(missing);
  await check('manifest outage: map remains operable and retry recovers',async()=>{
    await missing.route('**/inundation/manifest.json',r=>r.fulfill({status:503,body:'QA manifest failure'}));
    await missing.goto(base,{waitUntil:'domcontentloaded'});
    await missing.waitForFunction(()=>!!window.app,undefined,{timeout:45000});
    assert(await missing.locator('#caseSelect').isDisabled(),'unavailable case selector enabled');
    await missing.locator('button[data-city="23100"]').click();
    await missing.waitForFunction(()=>window.app.viewer.camera.positionCartographic.height<20000,undefined,{timeout:10000});
    await missing.unroute('**/inundation/manifest.json');await missing.locator('#retryData').click();
    await missing.waitForFunction(()=>window.app?.manifest.cases.length===2,undefined,{timeout:45000});
    return 'national map/city navigation survive missing data; reload retry restores cases';
  });
  const flat=await browser.newPage({viewport:{width:1440,height:1000}});instrument(flat);
  await check('terrain outage: explicit flat fallback and real data retained',async()=>{
    await flat.route('**/terrain/layer.json*',r=>r.fulfill({status:503,body:'QA terrain failure'}));
    await ready(flat);
    await flat.waitForFunction(()=>document.querySelector('#layerStatus').textContent.includes('平坦'),undefined,{timeout:30000});
    await flat.evaluate(()=>window.app.refresh());
    assert(await flat.evaluate(()=>window.app.cells.length>0),'computed cells lost with terrain failure');
    return flat.locator('#layerStatus').innerText();
  });
  const failurePage=await browser.newPage({viewport:{width:1440,height:1000}}); instrument(failurePage);
  await check('fault injection: failed new case cannot show stale cells',async()=>{
    await ready(failurePage); await failurePage.evaluate(()=>window.app.refresh());
    const ids=await failurePage.evaluate(()=>window.app.manifest.cases.filter(c=>c.available).map(c=>c.id));
    assert(ids.length>=2,'Requires at least 2 cases');
    // A fresh page ensures the second case is not in the application cache.
    await failurePage.route('**/inundation/**',route=>route.request().url().endsWith('/manifest.json')?route.continue():route.fulfill({status:503,contentType:'text/plain',body:'QA intentional failure'}));
    await failurePage.locator('#caseSelect').selectOption(ids[1]);
    await failurePage.waitForFunction(()=>document.querySelector('#layerStatus').textContent.includes('取得失敗'),undefined,{timeout:30000});
    assert(await failurePage.evaluate(()=>window.app.cells.length===0),'stale cells after network failure');
    await failurePage.screenshot({path:`${out}/network-failure.png`,fullPage:true});
    await failurePage.unroute('**/inundation/**'); await failurePage.evaluate(()=>window.app.refresh());
    await failurePage.waitForFunction(()=>window.app.cells.length>0,undefined,{timeout:60000}); return '503 is visible; previous cells removed; retry restored real data';
  });
} finally {
  report.finished=new Date().toISOString();
  await browser.close();
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,checks:report.checks,externalFailures:report.externalFailures.length,pageErrors:report.pageErrors.length},null,2));
  if(report.checks.some(c=>c.status==='failed') || report.pageErrors.length) process.exitCode=1;
}
