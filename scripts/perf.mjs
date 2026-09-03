#!/usr/bin/env node
/**
 * perf.mjs — Cesium 版の性能計測（同一条件で before/after を比べるための固定手順）
 *
 *  1. `dist/`（`npm run build` 済み）を `vite preview --port 5285` で配信
 *  2. ヘッドレス Chrome（CDP・ポート 5289、SwiftShader）で `/?m=39201&c=4` を
 *     desktop 1280×800（DPR1）と mobile 390×844（iPhone UA・DPR2）で読み込む
 *  3. 計測: 初期表示（地形タイル読込完了 `globe.tilesLoaded` かつ水面エンティティあり）までの時間、
 *     そこまでの HTTP リクエスト数・転送バイト（ホスト別）、JS ヒープ、
 *     操作時のフレーム時間（カメラを 3 秒間回転→2 秒間ズームさせ `scene.postRender` の間隔を記録）
 *  4. `docs/perf/<label>.json` に保存し、要約を表示
 *
 * 注意: ヘッドレス Chrome は GPU がソフトウェア描画（SwiftShader）のため、絶対値（fps）は実機より低い。
 *       同じマシン・同じ条件での相対比較（変更前後）に使う。数値は計測結果のみを記録し推測しない。
 *
 * 使い方: node scripts/perf.mjs --label baseline [--query "?m=39201&c=4"] [--quality lite|standard|high]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'perf');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5285;
const CDP_PORT = 5289;
const ARGS = process.argv.slice(2);
const flag = (n) => (ARGS.includes(n) ? ARGS[ARGS.indexOf(n) + 1] : null);
const LABEL = flag('--label') || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const QUERY = flag('--query') || '?m=39201&c=4';
const QUALITY = flag('--quality'); // 品質設定を URL で強制（?q=lite など。アプリ側が対応している場合）
const READY_TIMEOUT = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a) => console.log(`[perf ${new Date().toISOString().slice(11, 19)}]`, ...a);

const VIEWPORTS = [
  { name: 'desktop-1280x800', width: 1280, height: 800, dpr: 1, mobile: false, ua: null },
  {
    name: 'mobile-390x844', width: 390, height: 844, dpr: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(`${msg.sessionId || ''}:${msg.method}`) || []) h(msg.params);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify(payload)); });
  }
  on(method, handler, sessionId = '') {
    const key = `${sessionId}:${method}`; if (!this.handlers.has(key)) this.handlers.set(key, []); this.handlers.get(key).push(handler);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
}

async function waitForPort(port, timeoutMs = 20_000) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

async function launchChrome() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'perf-chrome-'));
  const args = ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--window-size=1280,900', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'];
  const child = spawn(CHROME, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (d) => (stderr += d.toString()));
  const t0 = now(); let version = null;
  while (now() - t0 < 20_000) { try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(200); } }
  if (!version) { killTree(child); throw new Error(`Chrome CDP not available: ${stderr.slice(-400)}`); }
  return { child, browser: await CDP.connect(version.webSocketDebuggerUrl), userDataDir, version };
}

// アプリ内で実行する計測スクリプト（frame time 収集）
const INTERACT_SCRIPT = `
(async () => {
  const v = window.viewer; const s = v.scene; const C = window.Cesium;
  const frames = []; const renders = []; let last = performance.now(); let preT = 0;
  const onPre = () => { preT = performance.now(); };
  const onPost = () => { const t = performance.now(); frames.push(t - last); renders.push(t - preT); last = t; };
  s.preRender.addEventListener(onPre);
  s.postRender.addEventListener(onPost);
  const start = performance.now();
  // 3 秒: 視点回転（毎フレーム少しずつ回す）。2 秒: ズームイン→アウト
  await new Promise((done) => {
    const step = () => {
      const el = performance.now() - start;
      if (el < 3000) { v.camera.rotateRight(0.004); s.requestRender(); requestAnimationFrame(step); }
      else if (el < 4000) { v.camera.zoomIn(v.camera.positionCartographic.height * 0.01); s.requestRender(); requestAnimationFrame(step); }
      else if (el < 5000) { v.camera.zoomOut(v.camera.positionCartographic.height * 0.01); s.requestRender(); requestAnimationFrame(step); }
      else done();
    };
    requestAnimationFrame(step);
  });
  s.preRender.removeEventListener(onPre);
  s.postRender.removeEventListener(onPost);
  const arr = frames.slice(1).sort((a, b) => a - b);
  const rarr = renders.slice(1).sort((a, b) => a - b);
  const pick = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : null;
  const p = (q) => pick(arr, q);
  const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const ravg = rarr.length ? rarr.reduce((a, b) => a + b, 0) / rarr.length : null;
  return { frames: arr.length, avgMs: avg, p50Ms: p(0.5), p95Ms: p(0.95), maxMs: arr.length ? arr[arr.length - 1] : null, fpsAvg: avg ? 1000 / avg : null,
    renderAvgMs: ravg, renderP95Ms: pick(rarr, 0.95), renderMaxMs: rarr.length ? rarr[rarr.length - 1] : null,
    heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
    resolutionScale: v.resolutionScale, globeSSE: s.globe.maximumScreenSpaceError, quality: window.app?.quality?.() ?? null,
    tilesets: window.app?.tilesets?.stats?.() ?? null, water: window.app?.water?.count?.() ?? null };
})()`;

async function runPage(browser, vp) {
  const url = `http://127.0.0.1:${PORT}/${QUERY}${QUALITY ? `&q=${QUALITY}` : ''}`;
  const res = { viewport: vp.name, url, ready: null, readyMs: null, network: { requests: 0, bytes: 0, byHost: {} }, heapMB: null, interact: null, errors: [] };
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => browser.send(m, p, sessionId);
  const inflight = new Map();
  browser.on('Network.requestWillBeSent', (p) => { if (!/^(data|blob):/.test(p.request.url)) { inflight.set(p.requestId, p.request.url); res.network.requests++; } }, sessionId);
  browser.on('Network.loadingFinished', (p) => {
    const u = inflight.get(p.requestId); inflight.delete(p.requestId); if (!u) return;
    res.network.bytes += p.encodedDataLength || 0;
    try { const h = new URL(u).host; res.network.byHost[h] = (res.network.byHost[h] || 0) + (p.encodedDataLength || 0); } catch { /* ignore */ }
  }, sessionId);
  browser.on('Runtime.exceptionThrown', (p) => res.errors.push(p.exceptionDetails?.exception?.description?.slice(0, 200) || 'exception'), sessionId);
  await s('Network.enable'); await s('Runtime.enable'); await s('Page.enable');
  // 起動時のメインスレッド長時間タスク（>50ms）を記録
  await s('Page.addScriptToEvaluateOnNewDocument', { source: `window.__lt = { count: 0, totalMs: 0, maxMs: 0 }; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__lt.count++; window.__lt.totalMs += e.duration; window.__lt.maxMs = Math.max(window.__lt.maxMs, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch (e) {}` });
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  await s('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile });
  if (vp.ua) await s('Emulation.setUserAgentOverride', { userAgent: vp.ua });
  if (vp.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const t0 = now();
  await s('Page.navigate', { url });
  // ready: 地形タイル読込完了 && 水面エンティティ >= 1
  let ready = false;
  while (now() - t0 < READY_TIMEOUT) {
    const r = await s('Runtime.evaluate', { expression: `(() => { const v = window.viewer; if (!v) return false; return !!(v.scene.globe.tilesLoaded && window.app && window.app.water && window.app.water.count() > 0); })()`, returnByValue: true });
    if (r.result?.value === true) { ready = true; break; }
    await sleep(250);
  }
  res.ready = ready; res.readyMs = Math.round(now() - t0);
  const cesiumErr = await s('Runtime.evaluate', { expression: `document.querySelector('.cesium-widget-errorPanel') ? document.querySelector('.cesium-widget-errorPanel').textContent.slice(0, 200) : null`, returnByValue: true });
  if (cesiumErr.result?.value) res.errors.push('cesium renderError: ' + cesiumErr.result.value);
  const lt = await s('Runtime.evaluate', { expression: 'window.__lt', returnByValue: true });
  res.longTasksUntilReady = lt.result?.value ?? null;
  const heap = await s('Runtime.evaluate', { expression: 'performance.memory ? performance.memory.usedJSHeapSize/1048576 : null', returnByValue: true });
  res.heapMB = heap.result?.value == null ? null : Math.round(heap.result.value * 10) / 10;
  res.network.readyRequests = res.network.requests; res.network.readyBytes = res.network.bytes;
  // 操作計測
  await sleep(1000);
  const it = await s('Runtime.evaluate', { expression: INTERACT_SCRIPT, awaitPromise: true, returnByValue: true });
  res.interact = it.result?.value ?? null;
  res.network.afterInteractRequests = res.network.requests; res.network.afterInteractBytes = res.network.bytes;
  await browser.send('Target.closeTarget', { targetId });
  return res;
}

(async () => {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) { console.error('dist/ がありません。先に npm run build を実行してください'); process.exit(1); }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  if (!(await waitForPort(PORT))) { killTree(preview); throw new Error('vite preview が起動しません'); }
  const { child, browser, userDataDir, version } = await launchChrome();
  const out = { label: LABEL, generated: new Date().toISOString(), query: QUERY, quality: QUALITY, chrome: version.Browser, note: 'ヘッドレスChrome（SwiftShader・ソフトウェア描画）。絶対値は実機より低い。同条件の相対比較用', pages: [] };
  try {
    for (const vp of VIEWPORTS) { log(`計測: ${vp.name}`); out.pages.push(await runPage(browser, vp)); }
  } finally {
    browser.close(); killTree(child); killTree(preview); try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const file = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  for (const p of out.pages) {
    const i = p.interact || {};
    const lt = p.longTasksUntilReady || {};
    log(`${p.viewport}: ready=${p.ready} ${p.readyMs}ms, req=${p.network.readyRequests} bytes=${(p.network.readyBytes / 1048576).toFixed(1)}MB, heap=${p.heapMB}MB, longtasks=${lt.count}(${Math.round(lt.totalMs || 0)}ms, max ${Math.round(lt.maxMs || 0)}ms), frame avg=${i.avgMs?.toFixed(1)}ms p95=${i.p95Ms?.toFixed(1)}ms fps≈${i.fpsAvg?.toFixed(1)}, render cpu avg=${i.renderAvgMs?.toFixed(1)}ms p95=${i.renderP95Ms?.toFixed(1)}ms max=${i.renderMaxMs?.toFixed(1)}ms (${i.frames} frames), rs=${i.resolutionScale} sse=${i.globeSSE} q=${i.quality}, errors=${p.errors.length}`);
  }
  log(`保存: ${file}`);
})().catch((e) => { console.error(e); process.exit(1); });
