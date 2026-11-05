import {
  RANGED_FILE_DOCUMENT_CAPABILITY,
  RANGED_FILE_DOCUMENT_METHODS,
  type RangedFileDocumentDescriptor,
  type RangedFileDocumentRead,
  type RangedFileDocumentChunk
} from '../../../shared/ranged-file-document'
import type { RuntimeFileReadArgs } from './runtime-file-client-types'
import { rangeReadTarget } from './runtime-file-range-client'
import { pinRemoteFileAddress } from './runtime-paged-file-read'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from './runtime-environment-revision'
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

/** One authorized source, pinned to its owning runtime pairing for its whole lifetime. */
export async function openRuntimeRangeDocument(
  args: RuntimeFileReadArgs,
  assertReadable?: () => void
): Promise<RuntimeRangeDocument> {
  assertReadable?.()
  if (args.terminalArtifactGrantId)
    throw new Error('Ranged documents do not support artifact grants.')
  const address = rangeReadTarget(args)
  const remote = address ? pinRemoteFileAddress(address) : null
  if (remote) {
    await assertRuntimeEnvironmentCapability(
      remote.target.environmentId,
      RANGED_FILE_DOCUMENT_CAPABILITY,
      'Ranged binary documents require an updated Orca server.'
    )
  }
  const remoteCall = <T>(
    method: keyof typeof RANGED_FILE_DOCUMENT_METHODS,
    params: unknown,
    signal?: AbortSignal
  ): Promise<T> => {
    if (!remote) throw new Error('Missing owning runtime.')
    return callRuntimeRpc<T>(remote.target, RANGED_FILE_DOCUMENT_METHODS[method], params, {
      signal,
      expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
    })
  }
  const fs = window.api.fs
  const transport: RangeDocumentTransport = remote
    ? {
        open: () =>
          remoteCall('open', { worktree: remote.worktree, relativePath: remote.relativePath }),
        read: (params, signal) => remoteCall('read', params, signal),
        reload: (params) => remoteCall('reload', params),
        status: (params) => remoteCall('status', params),
        close: (params) => remoteCall('close', params),
        cancel: (params) => remoteCall('cancel', params)
      }
    : {
        open: () =>
          fs.rangeDocumentOpen({
            filePath: args.filePath,
            access: args.access,
            connectionId: args.connectionId,
            wakeWslDistro: args.wakeWslDistro
          }),
        read: (params) => fs.rangeDocumentRead(params),
        reload: (params) => fs.rangeDocumentReload(params),
        status: (params) => fs.rangeDocumentStatus(params),
        close: (params) => fs.rangeDocumentClose(params),
        cancel: (params) => fs.rangeDocumentCancel(params)
      }
  const descriptor = await transport.open()
  try {
    assertReadable?.()
  } catch (error) {
    await transport.close({ id: descriptor.id }).catch(() => {})
    throw error
  }
  const document = new RuntimeRangeDocument(descriptor, transport, assertReadable)
  if (remote) {
    const retired = onRuntimeEnvironmentsRetired((ids) => {
      if (ids.includes(remote.target.environmentId)) {
        document.invalidate()
        document.close()
      }
    })
    const replaced = onRuntimeEnvironmentRevisionsChanged((ids) => {
      if (ids.includes(remote.target.environmentId)) {
        document.invalidate()
        document.close()
      }
    })
    document.onDispose = () => {
      retired()
      replaced()
    }
  }
  return document
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
    if (this.disposed) throw new Error('The ranged document has been disposed.')
    if (this.requiresReload) {
      if (!this.invalidated) this.invalidate()
      return
    }
    this.watch()
  }

  onInvalidate(fn: (value: RangeDocumentValue) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  invalidate(): void {
    if (this.disposed) return
    this.generation += 1
    if (this.invalidated) return
    this.invalidated = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const [requestToken, controller] of this.reads) {
      controller.abort()
      void this.transport.cancel({ id: this.descriptor.id, requestToken }).catch(() => {})
    }
    for (const listener of this.listeners) listener(this.value())
  }

  private watch(): void {
    if (this.timer || this.closed || this.invalidated) return
    // The owner watches disk; status conveys that invalidation across local and paired transports.
    this.timer = setTimeout(() => {
      this.timer = undefined
      const generation = this.generation
      void this.transport.status({ id: this.descriptor.id }).then(
        (next) => {
          if (this.closed || generation !== this.generation) return
          if (!next.valid || next.version !== this.descriptor.version) this.invalidate()
          else this.watch()
        },
        () => {
          if (!this.closed && generation === this.generation) this.invalidate()
        }
      )
    }, 1000)
  }

  async read(
    range: RangeRead,
    signal?: AbortSignal
  ): Promise<{ version: number; bytes: ArrayBuffer; eof: boolean }> {
    this.assertReadable?.()
    if (range.version !== this.version)
      throw Object.assign(new Error('The document version is stale.'), { code: 'conflict' })
    if (this.closed || this.invalidated)
      throw new Error('The ranged document is unavailable. Reload explicitly.')
    if (this.reads.size >= 2)
      throw Object.assign(new Error('Two range reads are already in flight.'), {
        code: 'rate_limited'
      })
    const token = createBrowserUuid()
    const controller = new AbortController()
    const generation = this.generation
    const abort = () => {
      controller.abort()
      void this.transport.cancel({ id: this.descriptor.id, requestToken: token }).catch(() => {})
    }
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' })
    signal?.addEventListener('abort', abort, { once: true })
    this.reads.set(token, controller)
    try {
      const result = await this.transport.read(
        { id: this.descriptor.id, ...range, version: this.descriptor.version, requestToken: token },
        controller.signal
      )
      if (controller.signal.aborted || this.closed || generation !== this.generation)
        throw new Error('Range read cancelled or invalidated.')
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
      )
        this.invalidate()
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.reads.delete(token)
    }
  }

  async reload(): Promise<RangeDocumentValue> {
    this.assertReadable?.()
    if (this.disposed) throw new Error('The ranged document has been disposed.')
    if (this.reloading) return this.reloading
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
        if (this.reloading === reload) this.reloading = null
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
    if (this.closed) return
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
