import { defineConfig, type Plugin } from 'vite';
import cesium from 'vite-plugin-cesium';

/**
 * vite-plugin-cesium の役割
 *  - dev: `CESIUM_BASE_URL` を define し、node_modules/cesium/Build/CesiumUnminified を /cesium/ で配信
 *  - build: cesium を external にして dist/cesium/Cesium.js（グローバル `Cesium`）を <script> で読み込み、
 *           Assets / ThirdParty / Widgets / Workers / Cesium.js を dist/cesium/ へコピーする
 *
 * `base: './'` にすると、プラグイン内部で path.posix.join('./', 'cesium/') = 'cesium/' となり、
 * 生成 HTML の参照がすべて相対パスになる。Cesium.js はグローバル読込時に自身の <script src> から
 * 静的アセットの基準 URL を解決するため、サブパス配下の静的ホストでも Workers 等を正しく解決できる。
 */
function cesiumWithHeadInjection(): Plugin {
  const base = cesium() as Plugin;
  const original = base.transformIndexHtml;
  if (typeof original !== 'function') return base; // 想定外の形式ならそのまま使う
  return {
    ...base,
    // プラグイン既定は head-prepend で <meta charset> より前にタグを挿入するため、
    // <head> 末尾（head）へ差し替えて文字コード宣言を先頭に保つ
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const result = original.call(this, html, ctx);
        if (!Array.isArray(result)) return result;
        return result.map((t) => ({ ...t, injectTo: 'head' as const }));
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  // 相対パス配信（サブパス配下の静的ホスト・file 直開き以外の任意ディレクトリで動作）
  base: './',
  plugins: [cesiumWithHeadInjection()],
  // ポートは DATA_CONTRACT §6 に固定（Cesium 版: dev 5281 / preview 5285）。競合時は失敗させ、別ポートへ黙って逃がさない
  server: { host: true, port: 5281, strictPort: true },
  preview: { host: true, port: 5285, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: command === 'build' ? false : true,
    chunkSizeWarningLimit: 4000,
    // Cesium.js（約6MB）はプラグインが外部グローバルとして配置するため、アプリ本体のチャンクは小さい
    assetsInlineLimit: 4096,
  },
}));
