import type { EditMap } from './Chunk'

const DB_NAME = 'smooth-world'
const DB_VERSION = 2
const STORE_META = 'meta'
const STORE_EDITS = 'edits'

export interface SaveMeta {
  seed: number
  px: number
  py: number
  pz: number
  yaw: number
  pitch: number
  timeOfDay: number
  flying: boolean
  /** 持ち物（Inventory.toJSON の結果）。 */
  inventory: unknown
  /** 置いた松明。 */
  torches?: { x: number; y: number; z: number; yaw: number }[]
  /** 体力。 */
  health?: number
  /** 伐採した木のセルキー。 */
  chopped: number[]
}

interface PackedEdits {
  idx: Int32Array
  d: Float32Array
  mat: Uint8Array
}

/**
 * IndexedDB による永続化。地形そのものはシードから再生成できるので、
 * プレイヤーが加えた編集の差分だけを保存する。
 */
export class WorldStore {
  private db: IDBDatabase | null = null
  private readonly dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private source: ((key: string) => EditMap | undefined) | null = null
  private prefix = ''

  /** シードごとに保存領域を分ける。別シードのワールドに編集が混ざらないようにするため。 */
  constructor(seed: number) {
    this.prefix = `${seed}:`
  }

  async open(): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          // v1 はシードで区切られていなかったので作り直す
          if (db.objectStoreNames.contains(STORE_META)) db.deleteObjectStore(STORE_META)
          if (db.objectStoreNames.contains(STORE_EDITS)) db.deleteObjectStore(STORE_EDITS)
          db.createObjectStore(STORE_META)
          db.createObjectStore(STORE_EDITS)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      return true
    } catch {
      this.db = null
      return false
    }
  }

  setEditSource(fn: (key: string) => EditMap | undefined): void {
    this.source = fn
  }

  async loadMeta(): Promise<SaveMeta | null> {
    if (!this.db) return null
    return this.get<SaveMeta>(STORE_META, `${this.prefix}state`)
  }

  async saveMeta(meta: SaveMeta): Promise<void> {
    if (!this.db) return
    await this.put(STORE_META, `${this.prefix}state`, meta)
  }

  async loadAllEdits(): Promise<Map<string, EditMap>> {
    const out = new Map<string, EditMap>()
    if (!this.db) return out
    const db = this.db
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_EDITS, 'readonly')
      const store = tx.objectStore(STORE_EDITS)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }
        const raw = String(cursor.key)
        if (!raw.startsWith(this.prefix)) {
          cursor.continue()
          return
        }
        const key = raw.slice(this.prefix.length)
        const packed = cursor.value as PackedEdits
        const map: EditMap = new Map()
        for (let i = 0; i < packed.idx.length; i++) {
          map.set(packed.idx[i], { d: packed.d[i], mat: packed.mat[i] })
        }
        if (map.size > 0) out.set(key, map)
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
    return out
  }

  /** 編集のあったチャンクを記録し、まとめて遅延書き込みする。 */
  markDirty(key: string): void {
    if (!this.db) return
    this.dirty.add(key)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 1500)
  }

  async flush(): Promise<void> {
    if (!this.db || !this.source || this.dirty.size === 0) return
    const keys = [...this.dirty]
    this.dirty.clear()
    const db = this.db
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_EDITS, 'readwrite')
      const store = tx.objectStore(STORE_EDITS)
      for (const key of keys) {
        const map = this.source!(key)
        if (!map || map.size === 0) {
          store.delete(this.prefix + key)
          continue
        }
        const n = map.size
        const packed: PackedEdits = {
          idx: new Int32Array(n),
          d: new Float32Array(n),
          mat: new Uint8Array(n),
        }
        let i = 0
        for (const [k, rec] of map) {
          packed.idx[i] = k
          packed.d[i] = rec.d
          packed.mat[i] = rec.mat
          i++
        }
        store.put(packed, this.prefix + key)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  /** このシードのワールドの保存内容だけを消す。 */
  async clear(): Promise<void> {
    if (!this.db) return
    this.dirty.clear()
    const db = this.db
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_EDITS, STORE_META], 'readwrite')
      const edits = tx.objectStore(STORE_EDITS)
      const req = edits.openKeyCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return
        if (String(cursor.key).startsWith(this.prefix)) edits.delete(cursor.key)
        cursor.continue()
      }
      tx.objectStore(STORE_META).delete(`${this.prefix}state`)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  private get<T>(store: string, key: string): Promise<T | null> {
    const db = this.db!
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve((req.result as T) ?? null)
      req.onerror = () => reject(req.error)
    })
  }

  private put(store: string, key: string, value: unknown): Promise<void> {
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
}
