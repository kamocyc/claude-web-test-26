import type { MeshRequest, MeshResponse } from './chunk.worker'
import ChunkWorker from './chunk.worker?worker'

interface Job {
  req: MeshRequest
  key: string
  priority: number
  resolve: (res: MeshResponse) => void
}

/**
 * チャンク生成 Worker のプール。
 * 未着手のジョブはプレイヤーからの距離（priority が小さいほど先）で選ばれ、
 * 視界から外れたチャンクのジョブはキャンセルできる。
 */
export class WorkerPool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly queue = new Map<string, Job>()
  private readonly running = new Map<number, Job>()
  private nextId = 1

  constructor(size?: number) {
    const n =
      size ?? Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))
    for (let i = 0; i < n; i++) {
      const w = new ChunkWorker()
      w.onmessage = (ev: MessageEvent<MeshResponse>) => this.onDone(w, ev.data)
      this.workers.push(w)
      this.idle.push(w)
    }
  }

  get pending(): number {
    return this.queue.size + this.running.size
  }

  submit(key: string, req: Omit<MeshRequest, 'id'>, priority: number): Promise<MeshResponse> {
    return new Promise((resolve) => {
      // 同じチャンクの未実行ジョブが残っていれば置き換える（古い方は空で解決）
      const displaced = this.queue.get(key)
      if (displaced) displaced.resolve({ id: -1, empty: true })
      this.queue.set(key, { req: { ...req, id: 0 }, key, priority, resolve })
      this.pump()
    })
  }

  /** まだ実行されていないジョブを取り消す。 */
  cancel(key: string): void {
    const job = this.queue.get(key)
    if (job) {
      this.queue.delete(key)
      job.resolve({ id: -1, empty: true })
    }
  }

  reprioritize(key: string, priority: number): void {
    const job = this.queue.get(key)
    if (job) job.priority = priority
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.size > 0) {
      let best: Job | null = null
      for (const job of this.queue.values()) {
        if (!best || job.priority < best.priority) best = job
      }
      if (!best) return
      this.queue.delete(best.key)
      const worker = this.idle.pop()!
      best.req.id = this.nextId++
      this.running.set(best.req.id, best)
      const transfer: Transferable[] = []
      if (best.req.editIdx) transfer.push(best.req.editIdx.buffer)
      if (best.req.editD) transfer.push(best.req.editD.buffer)
      if (best.req.editMat) transfer.push(best.req.editMat.buffer)
      worker.postMessage(best.req, transfer)
    }
  }

  private onDone(worker: Worker, res: MeshResponse): void {
    const job = this.running.get(res.id)
    this.running.delete(res.id)
    this.idle.push(worker)
    if (job) job.resolve(res)
    this.pump()
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = 0
    this.idle.length = 0
    this.queue.clear()
    this.running.clear()
  }
}
