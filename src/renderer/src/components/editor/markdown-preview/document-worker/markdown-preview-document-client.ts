import {
  MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS,
  type MarkdownPreviewWorkerRequest,
  type MarkdownPreviewWorkerResult
} from './markdown-preview-document-types'

type WorkerTransport = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>
type PendingRequest = {
  type: MarkdownPreviewWorkerRequest['type']
  resolve: (result: MarkdownPreviewWorkerResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
type PreviewRequest =
  | Omit<Extract<MarkdownPreviewWorkerRequest, { type: 'load' }>, 'id'>
  | Omit<Extract<MarkdownPreviewWorkerRequest, { type: 'blocks' }>, 'id'>
  | Omit<Extract<MarkdownPreviewWorkerRequest, { type: 'search' }>, 'id'>

export class MarkdownPreviewDocumentClient {
  private nextId = 0
  private closed = false
  private readonly pending = new Map<number, PendingRequest>()

  constructor(
    private readonly worker: WorkerTransport,
    private readonly onFailure: (error: Error) => void
  ) {
    worker.onmessage = (event: MessageEvent<MarkdownPreviewWorkerResult>) => {
      const result = event.data
      const pending = this.pending.get(result.id)
      if (!pending) {
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(result.id)
      if (result.type === 'error') {
        const error = new Error(result.message)
        pending.reject(error)
        if (pending.type !== 'search') {
          this.fail(error)
        }
      } else {
        pending.resolve(result)
      }
    }
    worker.onerror = () => this.fail(new Error('Preview worker failed.'))
  }

  request(request: PreviewRequest): Promise<MarkdownPreviewWorkerResult> {
    if (this.closed) {
      return Promise.reject(new Error('Preview closed.'))
    }
    this.cancel(request.type)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.timeout(id), MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS)
      this.pending.set(id, { type: request.type, resolve, reject, timer })
      try {
        this.worker.postMessage({ ...request, id })
      } catch {
        this.fail(new Error('Unable to start preview processing.'))
      }
    })
  }

  cancel(type: PreviewRequest['type']): void {
    let cancelled = false
    for (const [id, pending] of this.pending) {
      if (pending.type !== type) {
        continue
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error('Preview request superseded.'))
      cancelled = true
    }
    if (cancelled && type === 'search') {
      this.stopSearch()
    }
  }

  private timeout(id: number): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    if (pending.type !== 'search') {
      this.fail(new Error('Preview processing timed out.'))
      return
    }
    this.pending.delete(id)
    pending.reject(new Error('Preview search timed out.'))
    this.stopSearch()
  }

  private stopSearch(): void {
    if (this.closed) {
      return
    }
    try {
      this.worker.postMessage({ id: ++this.nextId, type: 'cancel-search' })
    } catch {
      // Viewport requests retain their own failure handling.
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Preview closed.'))
    }
    this.pending.clear()
  }

  private fail(error: Error): void {
    this.close()
    this.onFailure(error)
  }
}
