# Smooth World

ゲームシステムは Minecraft ライクだが、**見た目にボクセル感が一切ない完全スムーズな地形**の
ブラウザゲーム。TypeScript + three.js + Vite。

- 無限に広がる地形をシードから生成し、リアルタイムでストリーミング
- 球ブラシで掘る／盛る（穴は常に真円で滑らか）
- 一人称の移動・衝突・ジャンプ・飛行・遊泳
- 素材（草／土／岩／砂）のホットバー
- 海面と水中表現、昼夜サイクル
- 編集差分は IndexedDB に保存され、リロードしても残る

## 動かす

```bash
npm install
npm run dev      # http://127.0.0.1:5173
```

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバ |
| `npm run build` | 本番ビルド（`dist/`） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | ユニットテスト（vitest） |
| `npm run test:e2e` | ブラウザ起動テスト（Playwright） |

## 操作

| キー | 動作 |
| --- | --- |
| `W` `A` `S` `D` | 移動 |
| `Space` | ジャンプ／上昇（飛行中）／浮上（水中） |
| `Space` ×2 | 飛行モードの切替 |
| `Shift` | ダッシュ／加速（飛行中） |
| `Ctrl` or `Q` | 下降（飛行中） |
| 左クリック | 掘る |
| 右クリック | 盛る（選択中の素材） |
| ホイール | ブラシ半径（1〜6 m） |
| `1`–`4` | 設置する素材の選択 |
| `F3` | ステータス表示の切替 |
| `Esc` | ポーズ |

## なぜボクセルに見えないのか

ワールドの実体はブロックの配列ではなく、**連続な密度場** `density(x, y, z)` である
（`> 0` が固体）。これを **Surface Nets** で等値面として取り出す。

| 課題 | 手法 |
| --- | --- |
| 段差の排除 | 符号が混在するセルごとに 1 頂点を置き、位置をエッジ交差点の平均にする（`surfaceNets.ts`） |
| 滑らかな陰影 | 法線は密度場の勾配（中央差分）を三線形補間して求める。面法線を使わないのでファセットが出ない |
| チャンクの継ぎ目 | 各チャンクは格子 `[-2, 32+2]` をサンプルし、セル `[-1, 32)` を生成する。隣接チャンクは同じ密度関数から同じコーナー値を得るので、境界の頂点は数値的に完全一致する |
| UV が存在しない | ワールド座標の**三面投影**でテクスチャを貼る。テクスチャは起動時に CPU で生成するタイリングノイズで、外部アセットは不要（`proceduralTextures.ts` / `TerrainMaterial.ts`） |
| 素材の境界 | 頂点属性を素材 ID ではなく **4 成分の重み** `matw` にして GPU 補間させる |
| 編集の丸さ | ブラシを符号付き距離場として合成する。設置 `d = max(d, r - dist)` / 掘削 `d = min(d, dist - r)`。何度掛けても発散せず常に真球（`edits.ts`） |
| 坂の歩行 | カプセル軸上の数点をサンプルし、`密度 / |勾配|` を侵入深さとして勾配方向へ押し出す。地形が滑らかなのでブロック地形のような段差登り処理が要らない（`Player.ts`） |

## 構成

```
src/
  main.ts                      ブートストラップとゲームループ
  engine/Renderer.ts           WebGLRenderer / scene / camera / fog
  engine/SkyDayNight.ts        空シェーダ・太陽・星・環境光
  engine/Water.ts              海面（頂点シェーダで波と法線）
  world/noise.ts               シード付き Perlin / Simplex / fBm / ridged
  world/density.ts             密度場と素材、チャンク密度グリッドの生成
  world/surfaceNets.ts         等値面抽出（このプロジェクトの心臓部）
  world/World.ts               チャンク管理・ストリーミング・密度サンプリング・編集
  world/chunk.worker.ts        生成＋メッシュ化を行う Worker
  world/WorkerPool.ts          優先度付きジョブキュー
  world/edits.ts               球ブラシ
  world/storage.ts             IndexedDB（編集差分とメタ情報）
  render/TerrainMaterial.ts    MeshStandardMaterial + 三面投影の拡張
  render/proceduralTextures.ts CPU 生成のタイリングノイズ
  player/                      入力・物理・レイマーチ
  ui/hud.ts                    HUD
```

密度は**メインスレッドでは一切保持しない**。衝突判定やレイキャストが必要とする点で
解析的に評価し、編集差分を上書きして三線形補間する（`World.sample`）。
Worker が作るメッシュと完全に同じ場を参照できるうえ、メモリ使用量はゼロ。
2D の高度成分は列単位でキャッシュされる。

## 主な調整パラメータ

| 値 | 場所 | 意味 |
| --- | --- | --- |
| `VIEW_DISTANCE` | `main.ts` | 描画距離（チャンク数）。既定 7 = 224 m |
| `CHUNK_SIZE` / `VOXEL_SIZE` | `world/constants.ts` | チャンクの分割数と 1 セルの大きさ。`VOXEL_SIZE` を下げるとディテールが増え負荷も増える |
| `SEA_LEVEL` / `CAVE_MIN_Y` | `world/constants.ts` | 海面の高さ、洞窟の下限 |
| `DensityField.height()` | `world/density.ts` | 大陸・山・丘の形状 |
| `dayLength` | `engine/SkyDayNight.ts` | 1 日の実時間（秒）。既定 900 |
| `MIN_BRUSH` / `MAX_BRUSH` | `main.ts` | ブラシ半径の範囲 |

## テスト

`npm test` は等値面抽出の正しさを検証する。

- 球の密度場から抽出した全頂点が半径の上に乗る（誤差 < 0.12 — ボクセル表現なら 0.5 前後になる）
- 頂点法線が解析的な外向き法線と一致する（内積 > 0.985）
- 全三角形の巻き順が外向き（裏面が出ない）
- **隣接チャンクを独立にメッシュ化しても境界の頂点が完全一致する**（継ぎ目が出ない証明）
- 球ブラシが冪等で、掘る↔盛るを往復しても密度が発散しない

`npm run test:e2e` は実際にブラウザで起動し、視界内チャンクが全てメッシュ化されること、
描画が継続すること、掘削がワールドに反映されることを確認してスクリーンショットを残す。
ヘッドレス環境は SwiftShader（CPU ラスタライザ）なので数 fps しか出ない。
フレームレートの測定ではなくフリーズ検出が目的。
