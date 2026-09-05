import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/funakoshiakira/workspace/mirror-app/node_modules/@playwright/test');
const base=process.env.QA_BASE_URL||'http://127.0.0.1:5295';
const out=`docs/dynamic-simulation/evidence/coastal-reference/${process.env.QA_RUN||'local'}`;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const report={base,checks:[],errors:[]};page.on('pageerror',e=>report.errors.push(String(e)));
async function coast(){await page.waitForFunction(()=>window.app?.layerStats.visible>0&&window.app.layerStats.preparedBatches>0);return page.evaluate(()=>({cells:window.app.cells.length,stats:window.app.layerStats,note:document.querySelector('#simulationReferenceNote').textContent}));}
async function complete(){await page.waitForFunction(()=>!!window.app.simulation.result,undefined,{timeout:45000});}
try{
 await page.goto(base);await page.waitForFunction(()=>window.app?.simulation);report.checks.push({name:'initial coast',detail:await coast()});
 await page.locator('#simulationModeCustom').check();await complete();report.checks.push({name:'coast after custom mode',detail:await coast()});
 await page.evaluate(()=>{const v=window.viewer;v.camera.setView({destination:v.scene.globe.ellipsoid.cartographicToCartesian({longitude:135*Math.PI/180,latitude:32*Math.PI/180,height:700000}),orientation:{heading:0,pitch:-Math.PI/2,roll:0}})});
 for(const offset of [-100,90,-40]){const box=await page.locator('#cesiumContainer canvas').first().boundingBox();const before=await page.evaluate(()=>window.app.simulation.config.lon);await page.mouse.click(box.x+box.width/2+offset,box.y+box.height/2);await complete();const after=await page.evaluate(()=>window.app.simulation.config.lon);if(before===after)throw Error('pin did not move');report.checks.push({name:`coast after pin ${offset}`,source:after,detail:await coast()});}
 await page.evaluate(()=>window.app.locate('39201'));await page.waitForTimeout(2500);await coast();await page.screenshot({path:out+'/coast-with-pin.png'});report.checks.push({name:'coast after zoom to Kochi',detail:await coast()});
 await page.locator('#simulationModeOfficial').check();report.checks.push({name:'official mode restored',detail:await coast()});
}finally{await browser.close();await writeFile(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;}
