import type {
  RangedFileDocumentDescriptor,
  RangedFileDocumentRead,
  RangedFileDocumentChunk
} from '../../../shared/ranged-file-document'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import { createBrowserUuid } from '@/lib/browser-uuid'

export type RangeRead = { version: number; offset: number; length: number }
export type RangeDocumentValue = {
  version: number
  byteLength: number
  maxReadBytes: number
  readOnly: true
  fileType?: string
}

export type RangeDocumentTransport = {
  open(): Promise<RangedFileDocumentDescriptor>
  read(params: RangedFileDocumentRead, signal?: AbortSignal): Promise<RangedFileDocumentChunk>
  reload(params: { id: string }): Promise<RangedFileDocumentDescriptor>
  status(params: { id: string }): Promise<RangedFileDocumentDescriptor>
  close(params: { id: string }): Promise<unknown>
  cancel(params: { id: string; requestToken: string }): Promise<unknown>
}

export class RuntimeRangeDocument {
  private closed = false
  private disposed = false
  private reloading: Promise<RangeDocumentValue> | null = null
  private invalidated = false
  private generation = 0
  private readonly reads = new Map<string, AbortController>()
  private readonly listeners = new Set<(value: RangeDocumentValue) => void>()
  private version: number
  onDispose?: () => void
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    public descriptor: RangedFileDocumentDescriptor,
    private readonly transport: RangeDocumentTransport,
    private readonly assertReadable?: () => void
  ) {
    this.version = descriptor.version
  }

  get requiresReload(): boolean {
    return this.closed || this.invalidated
  }

  value(fileType?: string): RangeDocumentValue {
    return {
      version: this.version,
      byteLength: this.descriptor.byteLength,
      maxReadBytes: this.descriptor.maxReadBytes,
      readOnly: true,
      ...(fileType ? { fileType } : {})
    }
  }

  async bind(): Promise<void> {
    this.assertReadable?.()
    if (this.disposed) {
      throw new Error('The ranged document has been disposed.')
    }
    if (this.requiresReload) {
      if (!this.invalidated) {
        this.invalidate()
      }
      return
    }
    this.watch()
  }

  onInvalidate(fn: (value: RangeDocumentValue) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  invalidate(): void {
    if (this.disposed) {
      return
    }
    this.generation += 1
    if (this.invalidated) {
      return
    }
    this.invalidated = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const [requestToken, controller] of this.reads) {
      controller.abort()
      void this.transport.cancel({ id: this.descriptor.id, requestToken }).catch(() => {})
    }
    for (const listener of this.listeners) {
      listener(this.value())
    }
  }

  private watch(): void {
    if (this.timer || this.closed || this.invalidated) {
      return
    }
    // The owner watches disk; status conveys that invalidation across local and paired transports.
    this.timer = setTimeout(() => {
      this.timer = undefined
      const generation = this.generation
      void this.transport.status({ id: this.descriptor.id }).then(
        (next) => {
          if (this.closed || generation !== this.generation) {
            return
          }
          if (!next.valid || next.version !== this.descriptor.version) {
            this.invalidate()
          } else {
            this.watch()
          }
        },
        () => {
          if (!this.closed && generation === this.generation) {
            this.invalidate()
          }
        }
      )
    }, 1000)
  }

  async read(
    range: RangeRead,
    signal?: AbortSignal
  ): Promise<{ version: number; bytes: ArrayBuffer; eof: boolean }> {
    this.assertReadable?.()
    if (range.version !== this.version) {
      throw Object.assign(new Error('The document version is stale.'), { code: 'conflict' })
    }
    if (this.closed || this.invalidated) {
      throw new Error('The ranged document is unavailable. Reload explicitly.')
    }
    if (this.reads.size >= 2) {
      throw Object.assign(new Error('Two range reads are already in flight.'), {
        code: 'rate_limited'
      })
    }
    const token = createBrowserUuid()
    const controller = new AbortController()
    const generation = this.generation
    const abort = () => {
      controller.abort()
      void this.transport.cancel({ id: this.descriptor.id, requestToken: token }).catch(() => {})
    }
    if (signal?.aborted) {
      throw Object.assign(new Error('Cancelled'), { code: 'cancelled' })
    }
    signal?.addEventListener('abort', abort, { once: true })
    this.reads.set(token, controller)
    try {
      const result = await this.transport.read(
        { id: this.descriptor.id, ...range, version: this.descriptor.version, requestToken: token },
        controller.signal
      )
      if (controller.signal.aborted || this.closed || generation !== this.generation) {
        throw new Error('Range read cancelled or invalidated.')
      }
      const bytes = decodeBase64Bytes(result.contentBase64)
      if (
        result.version !== this.descriptor.version ||
        bytes.length !== result.bytesRead ||
        bytes.length > range.length
      ) {
        this.invalidate()
        throw new Error('Invalid ranged document reply.')
      }
      return { version: range.version, bytes: bytes.buffer, eof: result.eof }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        !controller.signal.aborted &&
        !message.includes('range_document_busy') &&
        !message.includes('range_document_invalid_range')
      ) {
        this.invalidate()
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.reads.delete(token)
    }
  }

  async reload(): Promise<RangeDocumentValue> {
    this.assertReadable?.()
    if (this.disposed) {
      throw new Error('The ranged document has been disposed.')
    }
    if (this.reloading) {
      return this.reloading
    }
    this.invalidate()
    const generation = ++this.generation
    const reload = (
      this.closed ? this.transport.open() : this.transport.reload({ id: this.descriptor.id })
    )
      .then((next) => {
        try {
          this.assertReadable?.()
          if (this.disposed || generation !== this.generation) {
            throw Object.assign(new Error('Document reload was cancelled.'), { code: 'cancelled' })
          }
        } catch (error) {
          this.closed = true
          void this.transport.close({ id: next.id }).catch(() => {})
          throw error
        }
        this.descriptor = next
        this.version += 1
        this.closed = false
        this.invalidated = false
        this.watch()
        return this.value()
      })
      .finally(() => {
        if (this.reloading === reload) {
          this.reloading = null
        }
      })
    this.reloading = reload
    return reload
  }

  dispose(): void {
    this.disposed = true
    this.close()
    this.onDispose?.()
    this.listeners.clear()
  }

  close(): void {
    this.generation += 1
    if (this.closed) {
      return
    }
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const [requestToken, controller] of this.reads) {
      controller.abort()
      void this.transport.cancel({ id: this.descriptor.id, requestToken }).catch(() => {})
    }
    void this.transport.close({ id: this.descriptor.id }).catch(() => {})
  }
}
