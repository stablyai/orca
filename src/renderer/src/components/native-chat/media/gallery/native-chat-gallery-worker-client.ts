import {
  nativeChatGalleryPackets,
  NativeChatGalleryWireDecoder
} from './native-chat-gallery-transfer'
import type {
  NativeChatGalleryWorkerCommand,
  NativeChatGalleryWorkerResult,
  NativeChatGalleryWireRequest,
  NativeChatGalleryWireResult
} from './native-chat-gallery-worker-protocol'

export class NativeChatGalleryWorkerClient {
  private worker: Worker | null = null
  private nextId = 0
  private response: {
    id: number
    revision: number
    resolve: (result: NativeChatGalleryWireResult) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private readonly isCurrent: (revision: number) => boolean,
    private readonly onRetire: () => void
  ) {}

  close(error: Error): void {
    if (this.response) {
      clearTimeout(this.response.timer)
      this.response.reject(error)
      this.response = null
    }
    this.worker?.terminate()
    this.worker = null
    this.onRetire()
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker
    }
    const worker = new Worker(new URL('./native-chat-gallery.worker.ts', import.meta.url), {
      type: 'module'
    })
    worker.onmessage = (event: MessageEvent<NativeChatGalleryWireResult>) => {
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
      if (result.type === 'failed') {
        response.reject(new Error('Image navigation worker failed'))
      } else {
        response.resolve(result)
      }
    }
    worker.onerror = () => {
      if (this.worker === worker) {
        this.close(new Error('Image navigation worker failed'))
      }
    }
    this.worker = worker
    return worker
  }

  private exchange(request: NativeChatGalleryWireRequest): Promise<NativeChatGalleryWireResult> {
    const worker = this.ensureWorker()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Image navigation timed out')), 30_000)
      this.response = { id: request.id, revision: request.revision, resolve, reject, timer }
      const mark = `native-chat-gallery:transfer:${request.revision}:${request.id}`
      performance.mark(`${mark}:start`)
      try {
        worker.postMessage(request)
      } catch (error) {
        this.close(error instanceof Error ? error : new Error('Unable to transfer chat images'))
      } finally {
        performance.mark(`${mark}:end`)
        performance.measure(mark, `${mark}:start`, `${mark}:end`)
        performance.clearMarks(`${mark}:start`)
        performance.clearMarks(`${mark}:end`)
        performance.clearMeasures(mark)
      }
    })
  }

  async request(
    revision: number,
    command: NativeChatGalleryWorkerCommand
  ): Promise<NativeChatGalleryWorkerResult | null> {
    const identity = { id: ++this.nextId, revision }
    const packets = nativeChatGalleryPackets(command)
    let current = packets.next()
    const incoming = new NativeChatGalleryWireDecoder()
    let result: NativeChatGalleryWireResult | undefined
    while (!current.done) {
      if (!this.isCurrent(revision)) {
        return null
      }
      const next = packets.next()
      result = await this.exchange({
        ...identity,
        type: 'push',
        tokens: current.value,
        last: next.done === true
      })
      current = next
    }
    while (result?.type === 'data') {
      incoming.push(result.tokens)
      if (result.last) {
        const value = incoming.take<NativeChatGalleryWorkerResult>()
        if (value.type === 'error' || value.type === 'superseded') {
          throw new Error(
            value.type === 'error' ? value.message : 'Gallery index revision was superseded'
          )
        }
        return this.isCurrent(revision) ? value : null
      }
      if (!this.isCurrent(revision)) {
        return null
      }
      result = await this.exchange({ ...identity, type: 'pull' })
    }
    if (!this.isCurrent(revision)) {
      return null
    }
    throw new Error('Gallery response ended without a result')
  }
}
