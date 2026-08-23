import type { EditMap } from './Chunk'

const DB_NAME = 'smooth-world'
const DB_VERSION = 1
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

  async open(): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
          if (!db.objectStoreNames.contains(STORE_EDITS)) db.createObjectStore(STORE_EDITS)
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
    return this.get<SaveMeta>(STORE_META, 'state')
  }

  async saveMeta(meta: SaveMeta): Promise<void> {
    if (!this.db) return
    await this.put(STORE_META, 'state', meta)
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
        const key = String(cursor.key)
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
          store.delete(key)
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
        store.put(packed, key)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async clear(): Promise<void> {
    if (!this.db) return
    this.dirty.clear()
    const db = this.db
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_EDITS, STORE_META], 'readwrite')
      tx.objectStore(STORE_EDITS).clear()
      tx.objectStore(STORE_META).clear()
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
