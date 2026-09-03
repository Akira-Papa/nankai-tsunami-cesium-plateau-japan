/**
 * 表示品質の段階設定（端末性能・画面サイズに応じて自動判定。利用者が上書き可）
 *
 * - high     : 従来品質（PC・十分な GPU）。解像度スケール上限 1、地形 SSE 2、大気表現あり、建物 8 都市・60 km まで
 * - standard : 高 DPI の大画面や内蔵 GPU 向け。解像度 1.25/DPR、地形 SSE 2.5、大気表現なし、建物 5 都市・40 km まで
 * - lite     : スマホ・低性能端末向け。解像度 1.0/DPR（最低 0.6）、地形 SSE 4、大気表現なし、建物 3 都市・25 km まで、
 *              地形の法線要求なし（タイルが軽くなる）
 *
 * 判定材料: タッチ端末かつ小画面、deviceMemory / hardwareConcurrency、devicePixelRatio と画面画素数、
 * WebGL のレンダラ名（SwiftShader / llvmpipe / Intel 内蔵など）。判定結果と理由は UI に表示する。
 * 数値は本リポジトリの `scripts/perf.mjs` の計測に基づいて調整する。
 */
import * as Cesium from 'cesium';

export type QualityLevel = 'high' | 'standard' | 'lite';

export interface QualityProfile {
  level: QualityLevel;
  label: string;
  /** viewer.resolutionScale の算出（DPR に応じて） */
  resolutionScale: (dpr: number) => number;
  globeSSE: number;
  skyAtmosphere: boolean;
  fog: boolean;
  terrainVertexNormals: boolean;
  tileCacheSize: number;
  /** PLATEAU 3D Tiles */
  tilesetMaxLoaded: number;
  tilesetMaxConcurrent: number;
  tilesetMaxCameraHeight: number;
  tilesetMobileProfile: boolean;
  /** 水面ポリゴンの同時エンティティ上限 */
  waterMaxEntities: number;
}

export const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  high: {
    level: 'high', label: '高画質',
    resolutionScale: (dpr) => Math.min(1, 1.5 / dpr),
    globeSSE: 2, skyAtmosphere: true, fog: true, terrainVertexNormals: true, tileCacheSize: 100,
    tilesetMaxLoaded: 8, tilesetMaxConcurrent: 3, tilesetMaxCameraHeight: 60_000, tilesetMobileProfile: false,
    waterMaxEntities: 40,
  },
  standard: {
    level: 'standard', label: '標準',
    resolutionScale: (dpr) => Math.min(1, 1.25 / dpr),
    globeSSE: 2.5, skyAtmosphere: false, fog: true, terrainVertexNormals: true, tileCacheSize: 80,
    tilesetMaxLoaded: 5, tilesetMaxConcurrent: 2, tilesetMaxCameraHeight: 40_000, tilesetMobileProfile: false,
    waterMaxEntities: 30,
  },
  lite: {
    level: 'lite', label: '軽量',
    resolutionScale: (dpr) => Math.max(0.6, Math.min(0.85, 1.0 / dpr)),
    globeSSE: 4, skyAtmosphere: false, fog: true, terrainVertexNormals: false, tileCacheSize: 50,
    tilesetMaxLoaded: 3, tilesetMaxConcurrent: 2, tilesetMaxCameraHeight: 25_000, tilesetMobileProfile: true,
    waterMaxEntities: 16,
  },
};

export interface DetectResult {
  level: QualityLevel;
  reasons: string[];
  renderer: string | null;
}

/** WebGL のレンダラ名（取得できない環境では null） */
function webglRenderer(): string | null {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string);
    return typeof r === 'string' ? r : null;
  } catch {
    return null;
  }
}

export function detectQuality(): DetectResult {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const dpr = window.devicePixelRatio || 1;
  const touch = (nav.maxTouchPoints ?? 0) > 0;
  const shortSide = Math.min(screen.width, screen.height);
  const pixels = screen.width * screen.height * dpr * dpr;
  const mem = nav.deviceMemory;
  const cores = nav.hardwareConcurrency;
  const renderer = webglRenderer();
  const reasons: string[] = [];
  let level: QualityLevel = 'high';

  if (touch && shortSide < 900) { level = 'lite'; reasons.push('タッチ端末・小画面'); }
  if (typeof mem === 'number' && mem <= 4) { level = 'lite'; reasons.push(`メモリ ${mem} GB 以下`); }
  if (typeof cores === 'number' && cores <= 4 && level !== 'lite') { level = 'standard'; reasons.push(`CPU ${cores} コア`); }
  if (renderer && /swiftshader|llvmpipe|software/i.test(renderer)) { level = 'lite'; reasons.push('ソフトウェア描画'); }
  else if (renderer && /intel|uhd|iris|mali|adreno|powervr/i.test(renderer) && level === 'high') { level = 'standard'; reasons.push('内蔵・モバイル GPU'); }
  if (level === 'high' && dpr >= 2 && pixels > 2560 * 1440 * 1.5) { level = 'standard'; reasons.push('高 DPI の大画面'); }
  if (!reasons.length) reasons.push('十分な性能と判定');
  return { level, reasons, renderer };
}

/** Viewer 側の設定を適用（建物・水面は呼び出し側で再構成する） */
export function applySceneQuality(viewer: Cesium.Viewer, p: QualityProfile): void {
  const scene = viewer.scene;
  const dpr = window.devicePixelRatio || 1;
  viewer.resolutionScale = Math.round(p.resolutionScale(dpr) * 100) / 100;
  scene.globe.maximumScreenSpaceError = p.globeSSE;
  scene.globe.tileCacheSize = p.tileCacheSize;
  scene.fog.enabled = p.fog;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = p.skyAtmosphere;
  scene.globe.showGroundAtmosphere = p.skyAtmosphere;
  scene.requestRender();
}
