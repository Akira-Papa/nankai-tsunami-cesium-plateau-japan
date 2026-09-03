/**
 * 震源域（大すべり域・超大すべり域）の概略オーバーレイ（CesiumJS 版）
 *
 * 内閣府 南海トラフ巨大地震モデル検討会の津波ケース①〜⑪は「大すべり域・超大すべり域をどの海域に置くか」で
 * 区別される（例: ケース④「四国沖」）。公式報告書はその範囲を図で示すだけで、ポリゴンや経緯度は公表されていない。
 * 本モジュールは、南海トラフ沿いに設定した「帯」（陸側の縁と海溝側の縁を結ぶ 12 の断面。いずれも概略値）から、
 * 公式の区域名（駿河湾〜日向灘）に対応する区間を切り出して**概略の範囲**として描く。
 *
 * - 正確な断層線・破壊開始点・公式図の範囲そのものではない（UI と凡例に明記）
 * - 震源の一点ではなく「範囲」であることを示すため、赤の半透明塗り＋濃い赤の輪郭＋地名ラベルで表示する
 * - 地形にクランプ（ClassificationType.TERRAIN）して海面上に描く。浸水水面・建物・津波高の意味は変えない
 */
import * as Cesium from 'cesium';

/** 南海トラフ沿いの断面（北東→南西）。coast=陸側の縁（海岸から数〜十数 km 沖）、trough=海溝軸側の縁。いずれも概略値 */
interface Station {
  coast: [number, number];
  trough: [number, number];
}
export const STATIONS: Station[] = [
  { coast: [138.85, 34.95], trough: [138.45, 34.45] }, // 0 駿河湾
  { coast: [138.25, 34.55], trough: [138.05, 33.95] }, // 1 御前崎・遠州灘東
  { coast: [137.45, 34.55], trough: [137.35, 33.65] }, // 2 遠州灘西・愛知県東部沖
  { coast: [136.85, 34.25], trough: [136.75, 33.25] }, // 3 伊勢湾口・三重県沖
  { coast: [136.25, 33.85], trough: [136.15, 32.85] }, // 4 熊野灘・三重県南部沖
  { coast: [135.75, 33.35], trough: [135.55, 32.55] }, // 5 潮岬・紀伊半島沖
  { coast: [134.95, 33.55], trough: [134.85, 32.45] }, // 6 徳島県沖
  { coast: [134.25, 33.15], trough: [134.15, 32.25] }, // 7 室戸岬沖
  { coast: [133.45, 33.25], trough: [133.45, 32.05] }, // 8 土佐湾・四国沖
  { coast: [132.85, 32.65], trough: [132.85, 31.75] }, // 9 足摺岬沖
  { coast: [132.05, 32.45], trough: [132.15, 31.55] }, // 10 日向灘北
  { coast: [131.55, 31.65], trough: [131.75, 31.05] }, // 11 日向灘南
];

/** 公式の区域名 → 帯の区間（断面番号。小数は隣接断面との補間） */
export interface SlipRegionDef {
  key: string;
  name: string;
  from: number;
  to: number;
}
export const SLIP_REGIONS: Record<string, SlipRegionDef> = {
  suruga_kii: { key: 'suruga_kii', name: '駿河湾〜紀伊半島沖', from: 0, to: 5.5 },
  kii: { key: 'kii', name: '紀伊半島沖', from: 4, to: 6 },
  kii_shikoku: { key: 'kii_shikoku', name: '紀伊半島沖〜四国沖', from: 4, to: 8.5 },
  shikoku: { key: 'shikoku', name: '四国沖', from: 6, to: 9 },
  shikoku_kyushu: { key: 'shikoku_kyushu', name: '四国沖〜九州沖', from: 6, to: 11 },
  suruga_aichi: { key: 'suruga_aichi', name: '駿河湾〜愛知県東部沖', from: 0, to: 2.5 },
  mie_tokushima: { key: 'mie_tokushima', name: '三重県南部沖〜徳島県沖', from: 3.5, to: 6.5 },
  aichi_mie: { key: 'aichi_mie', name: '愛知県沖〜三重県沖', from: 2, to: 4 },
  muroto: { key: 'muroto', name: '室戸岬沖', from: 6.5, to: 7.5 },
  ashizuri: { key: 'ashizuri', name: '足摺岬沖', from: 8.5, to: 9.5 },
  hyuganada: { key: 'hyuganada', name: '日向灘', from: 9.5, to: 11 },
};

function lerp(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function stationAt(idx: number, side: 'coast' | 'trough'): [number, number] {
  const i0 = Math.max(0, Math.min(STATIONS.length - 1, Math.floor(idx)));
  const i1 = Math.max(0, Math.min(STATIONS.length - 1, Math.ceil(idx)));
  const t = idx - Math.floor(idx);
  return lerp(STATIONS[i0][side], STATIONS[i1][side], i1 === i0 ? 0 : t);
}

/** 区間 [from, to] の帯ポリゴン（陸側の縁を北東→南西、海溝側の縁を南西→北東で閉じる） */
export function regionPolygon(def: SlipRegionDef): [number, number][] {
  const coast: [number, number][] = [];
  const trough: [number, number][] = [];
  const first = Math.ceil(def.from);
  const last = Math.floor(def.to);
  coast.push(stationAt(def.from, 'coast'));
  trough.push(stationAt(def.from, 'trough'));
  for (let i = first; i <= last; i++) {
    if (i === def.from || i === def.to) continue;
    coast.push(STATIONS[i].coast);
    trough.push(STATIONS[i].trough);
  }
  coast.push(stationAt(def.to, 'coast'));
  trough.push(stationAt(def.to, 'trough'));
  const ring = [...coast, ...trough.reverse()];
  ring.push(ring[0]);
  return ring;
}

export function regionCentroid(def: SlipRegionDef): [number, number] {
  const mid = (def.from + def.to) / 2;
  return lerp(stationAt(mid, 'coast'), stationAt(mid, 'trough'), 0.5);
}

/** 表示中の区域の経緯度範囲（度）。空なら null */
export function regionsBBox(keys: string[]): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const k of keys) {
    const d = SLIP_REGIONS[k];
    if (!d) continue;
    for (const [x, y] of regionPolygon(d)) {
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export interface SlipOverlay {
  /** 表示する区域キー（空配列で非表示）。複数なら番号付きラベル */
  setRegions(keys: string[]): void;
  /** 表示中の区域の範囲。非表示なら null */
  bbox(): [number, number, number, number] | null;
  keys(): string[];
  dispose(): void;
}

/**
 * 地図へ赤い震源域オーバーレイを追加する。ポリゴンは地形にクランプして海面上に描き、
 * 輪郭は clampToGround のポリライン、ラベルは深度テストを無効化して常に読めるようにする。
 */
export function createSlipOverlay(viewer: Cesium.Viewer): SlipOverlay {
  // 色はここで生成（モジュール読込時に Cesium へ触れず、幾何関数だけを node でテストできるようにする）
  const FILL = Cesium.Color.fromCssColorString('#dc2626').withAlpha(0.28);
  const OUTLINE = Cesium.Color.fromCssColorString('#991b1b').withAlpha(0.95);
  const LABEL_FILL = Cesium.Color.fromCssColorString('#7f1d1d');
  const LABEL_BG = Cesium.Color.WHITE.withAlpha(0.94);
  const ds = new Cesium.CustomDataSource('震源域（概略）');
  void viewer.dataSources.add(ds);
  let current: string[] = [];

  function clear(): void {
    ds.entities.removeAll();
  }

  function setRegions(keys: string[]): void {
    current = keys.filter((k) => SLIP_REGIONS[k]);
    clear();
    const multi = current.length > 1;
    current.forEach((k, i) => {
      const def = SLIP_REGIONS[k];
      const ring = regionPolygon(def);
      const positions = Cesium.Cartesian3.fromDegreesArray(ring.flat());
      ds.entities.add({
        name: `震源域（概略）: ${def.name}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: FILL,
          classificationType: Cesium.ClassificationType.TERRAIN,
        },
      });
      ds.entities.add({
        polyline: {
          positions,
          width: 3,
          material: OUTLINE,
          clampToGround: true,
        },
      });
      const [lon, lat] = regionCentroid(def);
      const text = multi ? `${i + 1}  ${def.name}` : def.name;
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        label: {
          text,
          font: 'bold 14px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif',
          fillColor: LABEL_FILL,
          showBackground: true,
          backgroundColor: LABEL_BG,
          backgroundPadding: new Cesium.Cartesian2(8, 5),
          style: Cesium.LabelStyle.FILL,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.1, 3.0e6, 0.85),
        },
      });
    });
    viewer.scene.requestRender();
  }

  return {
    setRegions,
    bbox: () => regionsBBox(current),
    keys: () => [...current],
    dispose() {
      clear();
      viewer.dataSources.remove(ds, true);
    },
  };
}
