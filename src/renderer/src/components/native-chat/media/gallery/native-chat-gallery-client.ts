import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type { NativeChatGallerySlot } from './native-chat-gallery-surfaces'
import type {
  NativeChatGalleryWorkerRequest,
  NativeChatGalleryWorkerResult
} from './native-chat-gallery-worker-protocol'

export type NativeChatGallerySnapshot = {
  /** Chat/session and runtime generation; changes retire the worker and its cache. */
  scopeKey: string
  slots: readonly NativeChatTranscriptSlot[]
  waitingSlots: readonly NativeChatTranscriptSlot[]
  liveReasoning?: { message: Pick<NativeChatMessage, 'id' | 'blocks'>; growing: boolean }
  stoppedLabel: string
  visuals: boolean
}

type Ready = Extract<NativeChatGalleryWorkerResult, { type: 'ready' }>
type Job = {
  revision: number
  snapshot: NativeChatGallerySnapshot
  resolve: (result: Ready | null) => void
  reject: (error: Error) => void
}
type WorkerRequest =
  | Omit<Extract<NativeChatGalleryWorkerRequest, { type: 'begin' }>, 'id'>
  | Omit<Extract<NativeChatGalleryWorkerRequest, { type: 'slot' }>, 'id'>
  | Omit<Extract<NativeChatGalleryWorkerRequest, { type: 'reasoning' }>, 'id'>
  | Omit<Extract<NativeChatGalleryWorkerRequest, { type: 'commit' }>, 'id'>

function transferMessage(message: NativeChatMessage): NativeChatMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) =>
      block.type === 'tool-result' ? { ...block, output: '', editPatch: undefined } : block
    )
  }
}

function transferSlot(
  slot: Extract<NativeChatTranscriptSlot, { kind: 'message' }>
): NativeChatGallerySlot {
  return {
    message: transferMessage(slot.message),
    ...(slot.workRun ? { workRun: slot.workRun.map(transferMessage) } : {}),
    receipt: slot.receipt !== undefined,
    drawsMessage: slot.drawsMessage,
    activeTurnIsWorking: slot.activeTurnIsWorking,
    trailingRun: slot.trailingRun
  }
}

export class NativeChatGalleryClient {
  private worker: Worker | null = null
  private revision = 0
  private scopeKey: string | null = null
  private nextId = 0
  private running = false
  private queued: Job | null = null
  private active: Job | null = null
  private response: {
    id: number
    revision: number
    resolve: (result: NativeChatGalleryWorkerResult) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(private readonly onProgress?: (completedSlots: number) => void) {}

  index(snapshot: NativeChatGallerySnapshot): Promise<Ready | null> {
    if (this.scopeKey !== null && this.scopeKey !== snapshot.scopeKey) {
      this.close()
    }
    this.scopeKey = snapshot.scopeKey
    this.queued?.resolve(null)
    return new Promise((resolve, reject) => {
      this.queued = { revision: ++this.revision, snapshot, resolve, reject }
      void this.pump()
    })
  }

  close(): void {
    this.revision++
    this.scopeKey = null
    this.queued?.resolve(null)
    this.queued = null
    this.active?.resolve(null)
    this.release(new Error('Gallery closed'))
  }

  private release(error: Error): void {
    if (this.response) {
      clearTimeout(this.response.timer)
      this.response.reject(error)
      this.response = null
    }
    this.worker?.terminate()
    this.worker = null
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker
    }
    const worker = new Worker(new URL('./native-chat-gallery.worker.ts', import.meta.url), {
      type: 'module'
    })
    worker.onmessage = (event: MessageEvent<NativeChatGalleryWorkerResult>) => {
      if (this.worker !== worker) {
        return
      }
      const result = event.data
      const response = this.response
      if (!response || response.id !== result.id || response.revision !== result.revision) {
        return
      }
      clearTimeout(response.timer)
      this.response = null
      if (result.type === 'error' || result.type === 'superseded') {
        response.reject(
          new Error(
            result.type === 'error' ? result.message : 'Gallery index revision was superseded'
          )
        )
      } else {
        response.resolve(result)
      }
    }
    worker.onerror = () => {
      if (this.worker === worker) {
        this.release(new Error('Image navigation worker failed'))
      }
    }
    this.worker = worker
    return worker
  }

  private request(request: WorkerRequest): Promise<NativeChatGalleryWorkerResult> {
    const worker = this.ensureWorker()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.release(new Error('Image navigation timed out')), 30_000)
      this.response = { id, revision: request.revision, resolve, reject, timer }
      const mark = `native-chat-gallery:transfer:${request.revision}:${id}`
      performance.mark(`${mark}:start`)
      try {
        worker.postMessage({ ...request, id })
      } catch (error) {
        this.release(error instanceof Error ? error : new Error('Unable to transfer chat images'))
      } finally {
        performance.mark(`${mark}:end`)
        performance.measure(mark, `${mark}:start`, `${mark}:end`)
        performance.clearMarks(`${mark}:start`)
        performance.clearMarks(`${mark}:end`)
        performance.clearMeasures(mark)
      }
    })
  }

  private async appendSlots(
    job: Job,
    slots: readonly NativeChatTranscriptSlot[],
    completed = 0
  ): Promise<number> {
    for (const slot of slots) {
      if (job.revision !== this.revision) {
        return completed
      }
      completed++
      if (slot.kind !== 'message' || !slot.drawsMessage || slot.receipt) {
        continue
      }
      // Each acknowledged request resumes in a new worker-message task before the next slot.
      const result = await this.request({
        type: 'slot',
        revision: job.revision,
        slot: transferSlot(slot)
      })
      if (job.revision === this.revision && result.type === 'ack') {
        this.onProgress?.(completed)
      }
    }
    return completed
  }

  private async run(job: Job): Promise<Ready | null> {
    const { snapshot, revision } = job
    await this.request({
      type: 'begin',
      revision,
      scopeKey: snapshot.scopeKey,
      stoppedLabel: snapshot.stoppedLabel,
      visuals: snapshot.visuals
    })
    const completed = await this.appendSlots(job, snapshot.slots)
    if (revision !== this.revision) {
      return null
    }
    if (snapshot.liveReasoning) {
      await this.request({ type: 'reasoning', revision, ...snapshot.liveReasoning })
    }
    const total = await this.appendSlots(job, snapshot.waitingSlots, completed)
    if (revision !== this.revision) {
      return null
    }
    this.onProgress?.(total)
    const result = await this.request({ type: 'commit', revision })
    return revision === this.revision && result.type === 'ready' ? result : null
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      while (this.queued) {
        const job = this.queued
        this.queued = null
        this.active = job
        try {
          job.resolve(await this.run(job))
        } catch (error) {
          if (job.revision !== this.revision) {
            job.resolve(null)
          } else {
            job.reject(error instanceof Error ? error : new Error('Unable to index chat images'))
          }
          this.release(new Error('Gallery index abandoned'))
        } finally {
          this.active = null
        }
      }
    } finally {
      this.running = false
    }
  }
}
