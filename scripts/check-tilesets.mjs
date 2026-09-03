#!/usr/bin/env node
/**
 * PLATEAU 建築物 3D Tiles レジストリ（shared/DATA_CONTRACT.md §4 `plateau_tilesets.json`）の疎通チェック
 * （依存パッケージなし・Node 18+）
 *
 *   node scripts/check-tilesets.mjs [registry.json] [--md] [--concurrency N] [--timeout MS] [--filter 23100,39201]
 *
 * registry.json 省略時: ../shared/data/plateau_tilesets.json があればそれ、無ければ scripts/fixtures/plateau_tilesets.fixture.json。
 * 各 URL について GET（Origin ヘッダ付き）し、HTTP ステータス / access-control-allow-origin / tileset.json の
 * geometricError / root.boundingVolume / region と登録 bbox の差 / 応答サイズ / 所要時間 を表にし、都市別サマリを出す。
 * 同時 8 本。終了コード: 全 OK=0、1 件でも NG=1。
 */
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? def : def; };
const MD = argv.includes('--md');
const CONCURRENCY = Number(flag('--concurrency', 8)) || 8;
const TIMEOUT_MS = Number(flag('--timeout', 20000)) || 20000;
const FILTER = (flag('--filter', '') || '').split(',').filter(Boolean);
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--concurrency', '--timeout', '--filter'].includes(argv[i - 1]));
const ORIGIN = 'http://localhost:5281';
const BBOX_TOL_DEG = 1e-3;

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.resolve(here, '..', '..', 'shared', 'data', 'plateau_tilesets.json');
const FIXTURE = path.join(here, 'fixtures', 'plateau_tilesets.fixture.json');

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function resolveRegistryPath() {
  if (positional[0]) return path.resolve(positional[0]);
  if (await exists(SHARED)) return SHARED;
  return FIXTURE;
}

function degreesFromRegion(region) {
  if (!Array.isArray(region) || region.length < 4) return null;
  const d = (r) => (r * 180) / Math.PI;
  return [d(region[0]), d(region[1]), d(region[2]), d(region[3])];
}

async function probe(entry) {
  const t0 = performance.now();
  const out = { status: '-', acao: '-', geometricError: '-', rootBV: '-', bboxDiff: '-', bytes: 0, ms: 0, note: '' };
  try {
    const res = await fetch(entry.url, { headers: { origin: ORIGIN }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    out.status = String(res.status);
    out.acao = res.headers.get('access-control-allow-origin') ?? '(none)';
    const text = await res.text();
    out.bytes = Buffer.byteLength(text);
    if (res.ok) {
      try {
        const j = JSON.parse(text);
        out.geometricError = Number.isFinite(j.geometricError) ? Number(j.geometricError).toFixed(1) : 'missing';
        const bv = j.root?.boundingVolume ?? {};
        const k = ['region', 'box', 'sphere'].find((x) => x in bv);
        out.rootBV = k ?? 'missing';
        if (k === 'region' && Array.isArray(entry.bbox)) {
          const deg = degreesFromRegion(bv.region);
          const diff = Math.max(...deg.map((v, i) => Math.abs(v - entry.bbox[i])));
          out.bboxDiff = diff.toFixed(4);
          if (diff > BBOX_TOL_DEG) out.note = `bbox が tileset の region と ${diff.toFixed(3)}° ずれ`;
        } else if (k === 'region' && entry.bbox == null) {
          out.bboxDiff = 'null(登録なし)';
          out.note = `bbox 未登録（region あり: ${degreesFromRegion(bv.region).map((v) => v.toFixed(3)).join(',')}）`;
        }
      } catch {
        out.geometricError = 'not-json';
      }
    }
  } catch (e) {
    out.status = 'ERR';
    out.note = e?.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS} ms` : String(e?.message ?? e);
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); }
  }));
  return results;
}

function shortUrl(u) {
  return String(u).replace('https://assets.cms.plateau.reearth.io/assets/', '…/').replace('https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/', 'alias:');
}

function table(headers, rows) {
  if (MD) {
    console.log(`| ${headers.join(' | ')} |`);
    console.log(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const r of rows) console.log(`| ${r.map((c) => String(c).replaceAll('|', '\\|')).join(' | ')} |`);
    return;
  }
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ');
  console.log(line(headers));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

const ok = (p) => p.status === '200' && p.acao === '*' && !['missing', 'not-json'].includes(p.geometricError) && p.rootBV !== 'missing' && !p.note;

(async () => {
  const file = await resolveRegistryPath();
  const reg = JSON.parse(await readFile(file, 'utf8'));
  let list = Array.isArray(reg.tilesets) ? reg.tilesets : [];
  if (FILTER.length) list = list.filter((e) => FILTER.includes(e.city_code) || FILTER.includes(e.ward_code));
  console.log(`# レジストリ: ${file}`);
  console.log(`# generated=${reg.generated ?? '-'} source=${reg.source ?? '-'} tilesets=${list.length} 件  同時 ${CONCURRENCY}  ${new Date().toISOString()}`);
  if (list.length === 0) { console.log('検査対象がありません'); process.exitCode = 1; return; }

  const probes = await mapLimit(list, CONCURRENCY, probe);
  let failures = 0;
  const perCity = new Map();
  table(
    ['city', 'ward', 'lod', 'tex', 'year', 'status', 'ACAO', 'geomErr', 'rootBV', 'bboxΔ°', 'bytes', 'ms', 'url', 'result'],
    list.map((e, i) => {
      const p = probes[i];
      const good = ok(p);
      if (!good) failures++;
      const c = perCity.get(e.city_code) ?? { name: e.city, ok: 0, ng: 0 };
      good ? c.ok++ : c.ng++;
      perCity.set(e.city_code, c);
      return [e.city ?? e.city_code, e.ward ?? '-', e.lod, e.texture ? 'T' : 'N', e.year, p.status, p.acao, p.geometricError, p.rootBV, p.bboxDiff, p.bytes, p.ms, shortUrl(e.url), good ? 'OK' : `NG ${p.note}`.trim()];
    }),
  );
  console.log('\n# 都市別サマリ');
  table(['city_code', 'city', 'OK', 'NG'], [...perCity].map(([code, c]) => [code, c.name, c.ok, c.ng]));
  const noBbox = list.filter((e) => e.bbox == null).length;
  const nonOk = list.filter((e) => typeof e.http_status === 'number' && e.http_status !== 200).length;
  console.log(`\n合計: OK ${list.length - failures} / NG ${failures} （bbox null: ${noBbox} 件、登録 http_status≠200: ${nonOk} 件）`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
