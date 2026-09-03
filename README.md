# 南海トラフ 津波浸水3Dビジュアライザ 全国版（パターンA: CesiumJS + PLATEAU配信）

📖 使い方（非エンジニア向け）: [docs/manual/使い方マニュアル.md](docs/manual/使い方マニュアル.md)
📐 データ契約（全エージェント共通）: [../shared/DATA_CONTRACT.md](../shared/DATA_CONTRACT.md)

## 1. 概要

内閣府「南海トラフ巨大地震モデル検討会」が公表した市町村別の津波高（2025 年公表値・2012 年公表値）を、
全国の沿岸市区町村の実地形（PLATEAU-Terrain）と建物（PLATEAU 3D Tiles）の上に**一定高さの半透明水面**として重ね、
「どこまで水に浸かるか」を直感的に見る試作 Web アプリです。名古屋市版プロトタイプ（`A-cesium-plateau`）を全国版へ拡張したものです。

- 技術: CesiumJS 1.145（Cesium ion **不使用**）＋ Vite 6 ＋ TypeScript 5.9 ＋ japan-geoid（GSIGEO2011）
- データ: 国土地理院 地理院タイル／国土交通省 PLATEAU（地形・建物）／ハザードマップポータルサイト（重ねるハザードマップ 津波浸水想定）を**外部配信から直接取得**。内閣府津波高と市区町村一覧は `shared/data/` の JSON（データ契約 §1／§3）
- 配信形態: 静的ファイル（`dist/`）のみ。ルート直下でもサブパス配下でも動作（相対パスビルド）

> **免責**: 簡易可視化であり公式想定ではありません。内閣府の津波高は海岸線での最大値で、内陸へ一律に適用すると過大・過小になります。
> 避難判断は各自治体のハザードマップを参照してください（[ハザードマップポータルサイト](https://disaportal.gsi.go.jp/)）。

## 2. 起動

前提: Node.js 20.19 以上（Vite 6 の要件。動作確認は Node 22）

```bash
npm install
npm run dev        # http://localhost:5281/（開発サーバ・strictPort）
npm run typecheck  # tsc --noEmit（型検査のみ）
npm run build      # typecheck → vite build → dist/ を生成
npm run preview    # dist/ をローカル配信（http://localhost:5285/）
```

- ポートはデータ契約 §6 で固定（Cesium 版: dev **5281** / preview **5285**）。`strictPort: true` のため競合時は別ポートへ逃げず失敗します。
- URL クエリで初期状態を指定できます: `?m=39201`（市区町村コード 5 桁・区コードは親の政令市へ正規化）、`?h=5.0`（津波高 m・指定時はプリセット「手動」）。操作に応じて `history.replaceState` で URL に反映されるので、そのまま共有できます。

### 静的ホストへの配置

`dist/` の中身をそのまま置くだけで動作します。`vite.config.ts` で `base: './'` を指定しているため、
`https://example.com/` 直下でも `https://example.com/nankai-tsunami/` のようなサブパス配下でも同じ成果物が使えます。
Cesium ion のトークンは**不要**です。

## 3. 構成

```
A-cesium-plateau-japan/
├── index.html                 # UI の静的骨格（要素 ID は下表）・モバイル meta・preconnect・PWA・noscript／WebGL 非対応案内
├── vite.config.ts             # base './'、vite-plugin-cesium、ポート 5281/5285（strictPort）
├── public/
│   ├── manifest.webmanifest   # PWA マニフェスト（Service Worker は未導入）
│   ├── icons/                 # アイコン
│   └── data/                  # 開発用フィクスチャ（統合時に shared/data/ の実データへ置換）
├── src/
│   ├── main.ts                # Cesium 初期化・地形・建物・水面・公式レイヤ・タップ計測（DOM は触らない）
│   ├── ui.ts                  # UI 一式（DOM 生成・イベント・URL 同期）。main.ts とは initUi() の契約でのみ結合
│   ├── style.css              # UI スタイル（スマホ＝ボトムシート／PC＝左サイドパネル）
│   ├── data.ts                # shared/data/*.json の型・ロード（データ契約 §1／§3）
│   ├── water.ts / geoid.ts    # 水面・ジオイド補正（japan-geoid）
│   ├── tilesetManager.ts / tilesets.ts / catalog.ts  # PLATEAU 3D Tiles の解決・遅延読込
└── docs/manual/使い方マニュアル.md
```

### main.ts ⇄ ui.ts の契約

```ts
initUi({ municipalities, tsunami }, { onChange, onFlyTo, onResetView }, initial)
  → { setState, setStatus, setBanner, setReadout, getState }
UiState = { muniCode, heightM, preset: 'max_2025'|'mean_2025'|'max_2012'|'manual',
            showOfficial, showBuildings, lod2, imagery: 'pale'|'photo', showWater }
```

- `ui.ts` は `tsunami.rows` が空でも、`municipalities` が空でも動作します（「データなし」表示・手動スライダーのみ）。
- 市区町村を選ぶと津波高テーブルを表示し、`max_2025` があればプリセット `2025 最大` → `heightM` を設定、無ければ「手動」を維持します。
- スライダー操作は必ずプリセット `manual` に落とします。初期化時は `onChange` を呼びません（`getState()` で読み取り）。

### index.html の主な要素 ID

| ID | 役割 |
|---|---|
| `prefSelect` / `muniSearch` / `muniSelect` / `flyTo` / `muniCount` | 都道府県・部分一致検索・市区町村・「この市町村へ移動」 |
| `tsMuniName` `tsMax2025` `tsMean2025` `tsMax2012` `tsArea` `tsUnit` `tsNote` | 内閣府 津波高テーブル |
| `presets` / `heightSlider` / `heightReadout` | プリセット 4 ボタン（`data-preset`）／スライダー 0〜35 m／現在値 |
| `officialToggle` / `legend` | 公式浸水想定（重ねるハザードマップ）と凡例 |
| `bldgToggle` `lod2Toggle` `imageryPale` `imageryPhoto` `waterToggle` `resetView` | 表示トグル・視点リセット |
| `status` / `banner` / `readout` / `readoutHint` | 建物・tileset 状態／警告バナー／タップ地点リードアウト |
| `panel` / `panelToggle` / `disclaimer` / `attribution` | パネル開閉／免責（常時表示）／出典 |

### データフロー

```
ブラウザ（CesiumJS）
 ├─ 地図タイル      ──GET──▶ cyberjapandata.gsi.go.jp     淡色地図 / 全国最新写真
 ├─ 地形            ──GET──▶ tile.plateauview.mlit.go.jp  PLATEAU-Terrain（quantized-mesh）
 ├─ 建物            ──GET──▶ assets.cms.plateau.reearth.io PLATEAU 3D Tiles（都市・区別 tileset.json）
 ├─ 公式浸水想定    ──GET──▶ disaportaldata.gsi.go.jp      重ねるハザードマップ 津波浸水想定 統合タイル（z2〜17）
 ├─ 津波高・市区町村 ──GET──▶ ./data/*.json（shared/data/ 由来）
 └─ 水面            …… ブラウザ内で生成（高さ = T.P.高 + ジオイド高〈japan-geoid〉）
```

## 4. データ出典と利用条件

| データ | 提供元 | URL | 利用条件（要点） |
|---|---|---|---|
| 地図タイル（淡色地図・全国最新写真） | 国土地理院 | `https://cyberjapandata.gsi.go.jp/xyz/{pale,seamlessphoto}/…` | [地理院タイル利用規約](https://maps.gsi.go.jp/development/ichiran.html)。出典「地理院タイル」を明記 |
| 地形（PLATEAU-Terrain）・建物（3D 都市モデル 3D Tiles） | 国土交通省 PLATEAU | `https://tile.plateauview.mlit.go.jp/terrain`、`https://assets.cms.plateau.reearth.io/assets/…/tileset.json` | [PLATEAU 利用規約](https://www.mlit.go.jp/plateau/site-policy/)（CC BY 4.0 相当）。出典「PLATEAU（国土交通省）」を表示。URL は [PLATEAU データカタログ API](https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets) から解決 |
| 津波浸水想定（重ねるハザードマップ 統合タイル） | 国土地理院 ハザードマップポータルサイト | `https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png` | [ハザードマップポータルサイト 利用規約](https://disaportal.gsi.go.jp/) に従い出典「ハザードマップポータルサイト」を表示。元データは各都道府県の津波浸水想定 |
| 市町村別 津波高・浸水面積（2025／2012） | 内閣府 南海トラフ巨大地震モデル検討会 | [2025 一覧表](https://www.bousai.go.jp/jishin/nankai/kento_wg/pdf/ichiran.pdf)／[2012 一覧表](https://www.bousai.go.jp/jishin/nankai/pdf/shichouson_ichiran.pdf) | [内閣府 公共データ利用規約（第 1.0 版）](https://www.bousai.go.jp/)（出典明記） |
| 行政区域（市区町村一覧・ポリゴン） | 国土数値情報 N03 | `shared/data/municipalities*.json` | 国土数値情報の利用約款に従い出典を明記 |
| ジオイドモデル GSIGEO2011 | 国土地理院（`japan-geoid` パッケージ経由） | — | 測量成果使用 **承認番号 R 5JHs 560** を表示 |

画面下部の `#attribution` に「地理院タイル／PLATEAU（国土交通省）／ハザードマップポータルサイト／内閣府 南海トラフ巨大地震モデル検討会／japan-geoid GSIGEO2011（承認番号 R 5JHs 560）」を常時表示しています。
いずれも**配信元サーバへ直接アクセス**するため、大量アクセスや自動巡回はしないでください。

## 5. 公式浸水想定レイヤと凡例

「公式浸水想定を重ねる」を ON にすると、重ねるハザードマップの津波浸水想定タイルを地形上に重ねます。凡例（浸水深）はデータ契約 §6 の色です。

| 浸水深 | 色 |
|---|---|
| 0.3 m 未満 | `#FFFFB3` |
| 0.3〜0.5 m | `#F7F5A9` |
| 0.5〜1 m | `#F8E1A6` |
| 1〜3 m | `#FFD8C0` |
| 3〜5 m | `#FFB7B7` |
| 5〜10 m | `#FF9191` |
| 10〜20 m | `#F285C9` |
| 20 m 以上 | 紫 |

## 6. 既知の制約

- **内閣府の津波高は「海岸線での最大値」**（T.P. 基準・満潮位＋地殻変動考慮）です。本アプリはその値を市域全体へ**一律の水面高**として適用するため、海岸から離れた内陸では過大に、河川遡上や局所的な集中では過小になります。避難判断には使わず、公式浸水想定（重ねるハザードマップ／各自治体のハザードマップ）を参照してください。
- 水面は一定高さの平面で、津波の遡上・減衰・堤防・時間変化は考慮していません。
- 視野が経度・緯度で 5° を超える広域表示では水面を描きません（全国分のポリゴンを読み込まないため。ズームすると表示）。
- 内閣府一覧表に値が無い市区町村（`null`）は「データなし」と表示し、プリセットは無効化・手動スライダーのみになります。区コードは親の政令市コードへ正規化します。
- 建物 3D Tiles は PLATEAU 整備済み都市のみ。LOD2 は対応都市に限られ、通信量・メモリが増えます。
- 外部配信（PLATEAU・地理院・ハザードマップポータル）に依存するため、オフラインや配信停止時は表示できません。Service Worker は未導入（PWA はマニフェストのみ）。
- `maximum-scale=1.0`（ピンチ操作と地図の競合回避）のため、文字拡大はブラウザの文字サイズ設定をご利用ください。
- WebGL 非対応・無効環境では 3D 表示できません（`index.html` が判定して案内を表示）。
- **「震源域」の赤い範囲は概略です。** 内閣府は大すべり域・超大すべり域の位置を報告書の図で示すのみで、座標・ポリゴン・断層線・破壊開始点の数値を公表していません。本アプリは南海トラフ沿いの帯状モデル（`src/slipRegions.ts`。陸側・海溝側の縁とも概略値）から公式の区域名（例「四国沖」）に対応する区間を切り出して描いており、公式図と形・広がりは一致しません。震源の一点ではなく「範囲」であること、公式座標ではないことを UI・地図凡例に常時表示しています。
- **震度セレクタは参考表示のみ**です。気象庁 震度階級関連解説表の要約を示すだけで、浸水表示・津波高には一切影響しません（震度から浸水深は計算していません）。

## 6b. セミナー向け拡張（2026-09-03）

| 機能 | 実装 | 根拠・注意 |
|---|---|---|
| 津波の発生パターン（震源域） | `#caseSelect` で内閣府 津波ケース①〜⑪ を選ぶと、選択市区町村の `cases_2025[k]`（公表値）が津波高プリセット「ケース別」として水面高に反映。水面レイヤは他の市区町村にもそのケースの値を適用。URL `?c=` | 第二次報告（2012-08-29）津波断層モデル編 第2章の文言。2025 見直し本文「設定は前回報告と同様、合計 11 ケース」（`src/scenarios.ts`） |
| 震源域の概略オーバーレイ | `src/slipRegions.ts`: 帯（12 断面）から区域を切り出し、`ClassificationType.TERRAIN` のポリゴン（赤・不透明度 0.28）＋ `clampToGround` ポリライン（濃い赤）＋深度テスト無効のラベル（複数区域は番号付き）を `CustomDataSource` で表示。地図凡例 `#slipLegend`、パネル内凡例 `#caseMapLegend`、「震源域と市区町村を一画面に」（`#caseFit`。PC は左パネル、スマホは下部シートを避けて Rectangle を広げて flyTo） | 公式は範囲を図示のみ。**概略表示**であり公式図の正確な範囲・断層線・破壊開始点ではない旨を明記。「指定なし」で非表示 |
| 震度（参考） | `#intensitySelect` で気象庁 震度階級 5弱〜7 の解説を表示。URL `?si=`。地図・津波高は不変 | 気象庁 震度階級関連解説表（平成21年改定）／「津波を予測するしくみ」 |

## 6c. 操作方法メニュー・表示品質・軽量化（2026-09-03）

### 操作方法メニュー
- 画面右上の常設ボタン「？ 操作方法」（`#helpBtn`）でモーダル（`#helpModal`、`role="dialog"` `aria-modal="true"`）を開く。
  マウス／トラックパッド、タッチ、市区町村・津波ケース・震源域の選び方、津波の高さ、浸水深、初期位置への戻り方を短い日本語で記載
- 閉じる: ×ボタン、Esc、背景クリック。開いたとき×へフォーカス移動、Tab はモーダル内で循環、閉じると元のボタンへ戻る（`src/ui.ts`）
- スマホでは丸い「？」だけを右上に置き、パネル・凡例・赤い震源域を隠さない

### 表示品質（`src/quality.ts`）
| 段階 | 解像度スケール | 地形 SSE | 大気表現 | 地形法線 | 建物 3D Tiles | 水面上限 |
|---|---|---|---|---|---|---|
| 高画質 high | min(1, 1.5/DPR) | 2 | あり | あり | 8 都市・60 km まで | 40 面 |
| 標準 standard | min(1, 1.25/DPR) | 2.5 | なし | あり | 5 都市・40 km まで | 30 面 |
| 軽量 lite | 1.0/DPR（0.6〜0.85） | 4 | なし | なし | 3 都市・25 km まで（モバイル設定） | 16 面 |

- 自動判定: タッチ端末かつ小画面／deviceMemory ≤ 4 GB／ソフトウェア描画 → 軽量、CPU 4 コア以下／内蔵・モバイル GPU／高 DPI の大画面 → 標準、それ以外 → 高画質。判定理由はパネルの「表示品質」横に表示
- 利用者はパネルの「表示品質」で上書きでき、`localStorage`（`nankai-cesium.quality`）に保存。URL `?q=high|standard|lite` でも指定可
- 切替時は建物・水面レイヤを新しい上限で作り直す（数百 ms）

### 軽量化の内容（計測に基づく）
1. **沿岸ポリゴンの県別遅延読込**: 起動時に 14.7 MB の `municipalities_coastal.geojson` を読まず、表示範囲と交差する県の `data/coastal/{pref}.geojson`（最大 1.3 MB）だけを読む。視野が 5° を超える広域では水面を出さず、全県読込を避ける
2. **水面高を定数プロパティ化**: `CallbackProperty` だと Cesium が毎フレーム形状を再生成するため、スライダー変更時にだけ `ConstantProperty` を差し替える
3. **建物 3D Tiles の遅延読込**: カメラ停止から 450 ms 後に判定（連続操作中は要求しない）。初回は地形・水面の読込を優先して 1.5 秒後
4. **面積ゼロの環を除外**: 4 桁丸めで潰れた小島（120,132 環中 57,736 環）が Cesium の重心計算で NaN になり「Rendering has stopped」を起こしていたため、面積 1e-9 度² 以下の環を除外

### 計測結果（`scripts/perf.mjs`、ヘッドレス Chrome・SwiftShader・同一条件。絶対値は実機より低く、相対比較用）
`/?m=39201&c=4` を読み込み、地形タイル読込完了＋水面表示までを「初期表示」、その後 3 秒回転＋2 秒ズームの描画 CPU 時間を「操作時」とした。

| 条件 | 初期表示 | リクエスト | 転送量 | JS ヒープ | 起動時 長時間タスク | 操作時 描画CPU 平均 / p95 |
|---|---|---|---|---|---|---|
| 変更前 PC 1280×800 | 2,388 ms（初回 4,346 ms） | 233 | 22.9 MB | 197〜208 MB | 3 件・289 ms（最大 130 ms） | 6.1 / 7.2 ms |
| 変更後 PC（自動＝高画質） | 1,841 ms | 209 | 9.7 MB | 52.2 MB | 1 件・124 ms | 1.2 / 2.1 ms |
| 変更後 PC（標準） | 2,100 ms | 183 | 9.0 MB | 47.0 MB | 1 件・124 ms | 1.2 / 2.4 ms |
| 変更後 PC（軽量） | 2,085 ms | 149 | 7.9 MB | 49.3 MB | 1 件・126 ms | 1.2 / 2.2 ms |
| 変更前 スマホ 390×844 | 2,070 ms | 138 | 20.7 MB | 171 MB | 3 件・339 ms | 3.3 / 4.5 ms |
| 変更後 スマホ（自動＝軽量） | 1,557 ms | 135 | 8.2 MB | 59.6 MB | 2 件・257 ms | 1.0 / 2.1 ms |

フレーム間隔はヘッドレスでも 60 fps 上限で頭打ち（平均 16.6 ms）のため、描画 1 回あたりの CPU 時間で比較している。生データは `docs/perf/*.json`。

## 7. トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| 赤バナー「3D描画でエラーが発生しました: cartesian has a NaN component」／Cesium の「Rendering has stopped」 | 面積ゼロのポリゴン環（退化形状）が `PolygonGeometryUpdater` の重心計算で NaN を生む | `src/water.ts` の `ringArea()` で除外済み（2026-09-03）。再発時は `?q=` を変えて再現条件を絞り、該当市区町村の環を確認 |
| `npm run dev` が「Port 5281 is already in use」で止まる | `strictPort` により競合時は失敗する仕様 | 該当ポートのプロセスを終了する（`lsof -i :5281`）。ポート変更はデータ契約 §6 に従う |
| 市区町村セレクタが「市区町村データなし」 | `data/municipalities.json` が無い／`nankai_target`・`coastal` が全て false | `public/data/` にフィクスチャを置くか `shared/data/` を統合。キー名はデータ契約 §1 のまま |
| プリセットが全て「データなし」 | `tsunami_h.json` に該当 `code` の行が無い、または値が `null` | `rows[].code` と市区町村コードの一致を確認。名称一致でも救済するが `pref` が異なると不一致になる |
| `?m=23101` を付けても名古屋市にならない | 区コードは `wards` で親市へ正規化。`wards` が未記載だと不明コードとして無視 | `municipalities.json` の政令市に `wards` 配列を入れる |
| 公式浸水想定が出ない | ズーム範囲外（z2〜17 の外）・配信停止・タイルが透明（想定区域外） | 沿岸へ寄って再確認。DevTools の Network で `04_tsunami_newlegend_data` の応答を確認 |
| 水面が地形より数十 m ずれる | ジオイド補正の失敗 | `#status` の表示と Console の `[geoid]` ログを確認（japan-geoid の読込失敗時は既定値へフォールバック） |
| 建物が出ない／一部だけ出ない（黄色バナー） | tileset 取得失敗・URL 変更 | PLATEAU データカタログ API で URL を再取得し `shared/data/plateau_tilesets.json` を更新 |
| サブパス配下で真っ黒／Workers が 404 | `base` が `/` の絶対パスビルド | `vite.config.ts` の `base: './'` を維持して再ビルド |
| 「3D 表示（WebGL）が利用できません」 | WebGL 無効・GPU ブラックリスト | ハードウェアアクセラレーションを有効化。`chrome://gpu` で確認 |
| 赤バナー「処理に失敗しました: Could not establish connection…」 | Chrome 拡張機能由来の未処理拒否 | 本アプリでは無視する実装済み。シークレットウィンドウで再現しないことを確認 |

## 8. 検証記録（UI モジュール・2026-09-02）

- `npx tsc --noEmit`: `src/ui.ts` はエラー 0（他ファイルの並行改修に伴うエラーは各担当が解消）
- `src/ui.ts` を esbuild で単独バンドルし、フィクスチャ 7 市区町村・5 行で headless Chrome（CDP・ポート 5282/5283）にて検証:
  - 390×844: `scrollWidth == clientWidth`（横スクロールなし）、パネル内横あふれなし、スライダー当たり判定 44 px、全ボタン・セレクト・入力 44 px 以上
  - 市区町村選択 → テーブル更新・`2025 最大` 適用・URL `?h=16.0&m=39201`／プリセット切替／スライダー→`manual`／検索「黒潮」1 件 → Enter 選択／`null` 値のプリセット無効化／区コード→政令市正規化／`setReadout`・`setBanner`・パネル開閉
  - `rows: []`・`municipalities: []` の空データでも例外なく起動（手動スライダーのみ）
  - 1280×800: 左サイドパネル 380 px、凡例 2 列表示
