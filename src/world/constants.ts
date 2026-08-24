/** 1 チャンクの 1 辺のセル数。 */
export const CHUNK_SIZE = 32

/** 1 セルの一辺の長さ（メートル）。格子座標 → ワールド座標の倍率。 */
export const VOXEL_SIZE = 1

/**
 * 密度サンプルのパディング量。
 * チャンクは格子座標 [-PAD, CHUNK_SIZE + PAD] のコーナーをサンプルする。
 * - セルは [-1, CHUNK_SIZE) を生成する（隣接チャンクと同一の頂点を得るため）
 * - 法線用の中央差分にはさらに ±1 のコーナーが要る
 * ため PAD = 2 が必要十分。
 */
export const PAD = 2

/** 密度グリッドの 1 辺のサンプル数。 */
export const GRID = CHUNK_SIZE + 2 * PAD + 1

/** メッシュ化対象セルの 1 辺の数と、その先頭グリッドインデックス。 */
export const CELLS = CHUNK_SIZE + 1
export const CELL_BASE = PAD - 1

/** ワールドの垂直方向の範囲（チャンク単位）。 */
export const CHUNK_Y_MIN = -4
export const CHUNK_Y_MAX = 5

export const WORLD_MIN_Y = CHUNK_Y_MIN * CHUNK_SIZE
export const BEDROCK_Y = WORLD_MIN_Y + 4

export const SEA_LEVEL = 0

/** 洞窟が存在しうる最下部。 */
export const CAVE_MIN_Y = -78

/**
 * 素材 ID。0〜3 は地形が自然に持つ素材で、頂点属性 `matw` に、
 * 4〜6 はクラフトした建材で、頂点属性 `matw2` に重みが入る。
 */
export const MAT_GRASS = 0
export const MAT_DIRT = 1
export const MAT_ROCK = 2
export const MAT_SAND = 3
export const MAT_PLANK = 4
export const MAT_BRICK = 5
export const MAT_GLASS = 6
export const MAT_NONE = 255

/** 自然地形が持つ素材の数（密度場のサンプラが返す重みの数）。 */
export const NATURAL_MATERIAL_COUNT = 4

export const MATERIAL_COUNT = 7

/**
 * 素材の一覧。`repose` は安息角（度）で、0 でない素材は
 * 盛ると落ちてその傾斜の山になる（粒状の素材）。
 */
export const MATERIAL_INFO = [
  { id: MAT_GRASS, name: '草', color: '#6f9c46', repose: 0 },
  { id: MAT_DIRT, name: '土', color: '#7d5a3c', repose: 38 },
  { id: MAT_ROCK, name: '岩', color: '#8a8f96', repose: 0 },
  { id: MAT_SAND, name: '砂', color: '#d8c48a', repose: 32 },
  { id: MAT_PLANK, name: '板', color: '#b8874a', repose: 0 },
  { id: MAT_BRICK, name: 'レンガ', color: '#a8503c', repose: 0 },
  { id: MAT_GLASS, name: 'ガラス', color: '#9fd6e8', repose: 0 },
] as const

/**
 * シードを指定しなかったときに使う固定シード。
 * スクリーンショットやテストで同じワールドを再現するためのもの。
 */
export const SAMPLE_SEED = 20260823

/** 村を配置する粗いグリッドの一辺（m）。 */
export const VILLAGE_CELL = 420

export function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`
}

/** グリッド内のコーナー (i,j,k) → 配列インデックス。x が最も内側。 */
export function gridIndex(i: number, j: number, k: number): number {
  return i + GRID * (j + GRID * k)
}

/**
 * これより上向きが弱い面には立てない（cos 50°）。
 * プレイヤーも MOB もこれより急な坂は登れず、上にいると滑り落ちる。
 * この地形では傾斜 50°以上が全体の約 13%（60°以上なら 7%）なので、
 * 山の斜面が「迂回する対象」になり、丘はふつうに歩ける。
 */
export const WALKABLE_NY = 0.6428
