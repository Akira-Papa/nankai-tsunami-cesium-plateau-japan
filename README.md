# 南海トラフ 津波浸水3Dビジュアライザ 全国版（重量版・Cesium）

日本全国をCesiumで探索し、内閣府2025の計算済みデータを加工・集約した浸水表示を確認する防災学習サイト。

- 🌐 **公開サイト**: [https://nankai-tsunami-cesium-plateau-japan.akirafunakoshi.com](https://nankai-tsunami-cesium-plateau-japan.akirafunakoshi.com)
- 📖 **使い方（初心者向け）**: [docs/manual/使い方マニュアル.md](docs/manual/使い方マニュアル.md)
- 📐 **データ契約・台帳（全エージェント共通）**: [docs/precomputed/05_データ台帳.md](docs/precomputed/05_データ台帳.md)

---

## 表示内容

- 全国の自治体検索・都市ショートカット、俯瞰と3D傾斜、写真地図。
- ケース01・04の「津波が乗り越えたら堤防が破堤する」条件の加工データ。
- 表示範囲に応じた100m・500m・2500m相当の集約セル。色は集約内の最大参考浸水深。
- 到達モードは指定時刻までに1cmへ到達した元セルを含む集約範囲。時刻別の水深、波の伝播動画、引き波を表しません。
- 地点クリックで周辺の集約値、ケース、出典を確認。視点と条件の共有URL。
- 対応地域のPLATEAU建物、軽量表示、スマホの操作パネル折りたたみ。

## 読み違えないために

全国の地図を閲覧できることと、全地域・全ケースの浸水データを収録することは別です。「収録セルなし」は安全判定ではありません。

元データは10mメッシュですが、公開表示は100m以上に統計集約しています。表示四角形は実際の浸水境界でもセル全域の浸水深でもありません。最大深さと最早到達時間は異なる元セルに由来する場合があります。3D地形・建物の精細さは計算の精度や建物被害を示しません。現在の津波実況・避難経路の安全判定には使用できません。

## ローカル起動と検証

Node.js 20.19以上（Vercelでは対応するLTSを指定）を使用します。

```sh
npm ci
npm test
npm run build
npm run dev
```

開発用は `http://localhost:5281`、ビルド結果は `npm run preview` で `http://localhost:5285`。地図・建物には外部配信元へのネットワーク接続とWebGL対応ブラウザが必要です。APIキー・Cesium ionトークンは不要です。

## データ再生成

原本の出典、利用条件、列定義は [データ台帳](docs/precomputed/05_データ台帳.md) を確認してください。元ZIPはリポジトリと `public/` の外に保管します。

```sh
python3 scripts/precompute_inundation.py --input 1=/tmp/nankai-case01.zip --input 4=/tmp/nankai-case04.zip --output public/inundation
npm test
npm run build
```

変換器はPython標準ライブラリを使用し、原本ZIPのCRCを検査します。集約データと原本SHA256を含むマニフェストを生成します。ZIP・CSV原本や10mレコードの単純形式変換版を公開しないでください。公開対象は利用条件を確認して加工した集約統計です。

## Vercel配布

`vercel.json` は `npm ci` → `npm run build`、公開ディレクトリを `dist` に固定しています。環境変数や計算サーバーは不要です。地形・地図・建物の取得は外部配信元を利用するため、Vercelだけで全データを自前保有する構成ではありません。

既存プロジェクト `nankai-tsunami-cesium-plateau-japan` の改訂を想定しています。READMEの存在は本番反映の証明ではありません。公開後にデプロイ状態と実画面を確認してください。

詳しい操作・配布・キャッシュ・公開範囲の確認は [操作と配布手順](docs/precomputed/07_操作と配布手順.md) を参照してください。

## 根拠資料

- [内閣府 南海トラフ検討会](https://www.bousai.go.jp/jishin/nankai/kento_wg/index.html)
- [陸域における津波浸水深データ](https://www.geospatial.jp/ckan/dataset/26804359-b035-4df2-84cc-eb2121172a1e)
- [ニーズと要件](docs/precomputed/01_ニーズと要件整理.md)
- [開発方針](docs/precomputed/02_開発方針設計.md) / [レビュー](docs/precomputed/03_レビュー指摘.md) / [修正対応](docs/precomputed/04_開発方針修正対応報告.md)

`docs/` は開発資料です。`dist/` へコピーせず、Webサイトからは配信しません。

## ライセンスの区別
LICENSEのMITはアプリケーションコードに適用します。`public/inundation/`の内閣府資料を加工したデータ、地理院・PLATEAU等の外部データには各提供元の利用条件が適用されます。元の10mデータは同梱していません。詳しくは`docs/precomputed/05_データ台帳.md`を参照してください。
