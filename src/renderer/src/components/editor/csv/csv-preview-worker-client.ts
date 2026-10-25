import type {
  CsvWorkerCommand,
  CsvWorkerResponse,
  CsvWorkerValue
} from './csv-preview-worker-protocol'

export class CsvPreviewWorkerClient {
  private worker = new Worker(new URL('./csv-preview.worker.ts', import.meta.url), {
    type: 'module'
  })
  private nextId = 0
  private pending = new Map<
    number,
    { resolve: (value: CsvWorkerValue) => void; reject: (error: Error) => void }
  >()
  private closed = false

  constructor() {
    this.worker.onmessage = (event: MessageEvent<CsvWorkerResponse>) => {
      const response = event.data
      const request = this.pending.get(response.id)
      this.pending.delete(response.id)
      if (response.ok) {
        request?.resolve(response.value)
      } else {
        request?.reject(new Error(response.error))
      }
    }
    this.worker.onerror = () =>
      this.close(new Error('CSV preview worker failed. Reload the file to retry.'))
    this.worker.onmessageerror = () =>
      this.close(new Error('CSV preview worker returned an unreadable response.'))
  }

  request(command: CsvWorkerCommand): Promise<CsvWorkerValue> {
    if (this.closed) {
      return Promise.reject(new Error('CSV preview was canceled'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage({ id, command }, 'bytes' in command ? [command.bytes.buffer] : [])
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close(error = new Error('CSV preview was canceled')): void {
    this.closed = true
    this.worker.terminate()
    for (const request of this.pending.values()) {
      request.reject(error)
    }
    this.pending.clear()
  }
}
