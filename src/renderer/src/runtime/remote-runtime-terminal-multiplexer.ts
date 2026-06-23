/* eslint-disable max-lines -- Why: the remote terminal multiplexer owns one bridged subscription, stream lifecycle, binary frame parsing, and remote lock events as a single transport contract. */
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'

type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

type TerminalMultiplexEvent =
  | { type: 'ready' }
  | { type: 'subscribed'; streamId: number }
  | { type: 'end'; streamId: number }
  | { type: 'error'; streamId: number; message?: string }
  | {
      type: 'fit-override-changed'
      streamId: number
      mode: 'mobile-fit' | 'desktop-fit'
      cols: number
      rows: number
    }
  | {
      type: 'driver-changed'
      streamId: number
      driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
    }
  | { type: string; streamId?: number; [key: string]: unknown }

export type RemoteRuntimeMultiplexedTerminalCallbacks = {
  onData: (data: string, meta?: { seq?: number; rawLength?: number }) => void
  onSnapshot: (data: string) => void
  onSubscribed?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
  onFitOverrideChanged?: (event: {
    mode: 'mobile-fit' | 'desktop-fit'
    cols: number
    rows: number
  }) => void
  onDriverChanged?: (
    driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
  ) => void
  onTransportClose?: () => void
}

export type RemoteRuntimeMultiplexedTerminal = {
  streamId: number
  sendInput: (text: string) => boolean
  resize: (cols: number, rows: number) => boolean
  serializeBuffer: (opts?: { scrollbackRows?: number }) => Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    source?: 'headless' | 'renderer'
  } | null>
  close: () => void
}

type RemoteRuntimeMultiplexedTerminalState = {
  streamId: number
  terminal: string
  callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  snapshotChunks: Uint8Array<ArrayBufferLike>[]
  snapshotBytes: number
  snapshotOverflowed: boolean
  snapshotTarget: 'initial' | 'request'
  snapshotInfo: RemoteRuntimeSnapshotInfo | null
  initialSnapshotReceived: boolean
  pendingSnapshotRequest: RemoteRuntimeSnapshotRequest | null
}

type RemoteRuntimeSnapshotInfo = {
  cols?: number
  rows?: number
  seq?: number
  source?: 'headless' | 'renderer'
  requestId?: number
  truncated?: boolean
}

type RemoteRuntimeSnapshotRequest = {
  requestId: number
  resolve: (
    snapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      source?: 'headless' | 'renderer'
    } | null
  ) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CONTROL_STREAM_ID = 0
const MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024
const REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000
const REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE =
  'Remote terminal snapshot exceeded the 2 MiB replay limit; live output will continue.'

class RemoteRuntimeTerminalMultiplexer {
  private readonly streams = new Map<number, RemoteRuntimeMultiplexedTerminalState>()
  private subscription: RuntimeEnvironmentSubscriptionHandle | null = null
  private connectPromise: Promise<void> | null = null
  private readyResolver: (() => void) | null = null
  private readyRejecter: ((error: Error) => void) | null = null
  private ready = false
  private nextStreamId = 1
  private nextSnapshotRequestId = 1

  constructor(
    private readonly environmentId: string,
    private readonly releaseIfCurrent: (
      environmentId: string,
      multiplexer: RemoteRuntimeTerminalMultiplexer
    ) => void
  ) {}

  async subscribeTerminal(args: {
    terminal: string
    client: { id: string; type: 'desktop' | 'mobile' }
    viewport?: { cols: number; rows: number }
    callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  }): Promise<RemoteRuntimeMultiplexedTerminal> {
    const streamId = this.allocateStreamId()
    const state: RemoteRuntimeMultiplexedTerminalState = {
      streamId,
      terminal: args.terminal,
      callbacks: args.callbacks,
      snapshotChunks: [],
      snapshotBytes: 0,
      snapshotOverflowed: false,
      snapshotTarget: 'initial',
      snapshotInfo: null,
      initialSnapshotReceived: false,
      pendingSnapshotRequest: null
    }
    this.streams.set(streamId, state)

    const stream: RemoteRuntimeMultiplexedTerminal = {
      streamId,
      sendInput: (text) =>
        this.sendFrame(streamId, TerminalStreamOpcode.Input, encodeTerminalStreamText(text)),
      resize: (cols, rows) =>
        this.sendFrame(
          streamId,
          TerminalStreamOpcode.Resize,
          encodeTerminalStreamJson({ cols, rows })
        ),
      serializeBuffer: (opts) => this.requestSnapshot(state, opts),
      close: () => {
        if (this.streams.get(streamId) === state) {
          this.sendFrame(streamId, TerminalStreamOpcode.Unsubscribe)
          rejectPendingSnapshotRequest(state, 'Remote terminal stream closed.')
          this.streams.delete(streamId)
          this.closeIfIdle()
        }
      }
    }

    try {
      await this.ensureConnected()
      if (this.streams.get(streamId) !== state) {
        return stream
      }
      const sent = this.sendFrame(
        CONTROL_STREAM_ID,
        TerminalStreamOpcode.Subscribe,
        encodeTerminalStreamJson({
          streamId,
          terminal: args.terminal,
          client: args.client,
          viewport: args.viewport
        })
      )
      if (!sent) {
        throw new Error('Remote terminal stream is not connected.')
      }
    } catch (error) {
      const terminalError = error instanceof Error ? error : new Error(String(error))
      if (this.streams.get(streamId) === state) {
        this.streams.delete(streamId)
        this.closeIfIdle()
      }
      throw terminalError
    }

    return stream
  }

  private allocateStreamId(): number {
    const start = this.nextStreamId
    do {
      const candidate = this.nextStreamId
      this.nextStreamId = this.nextStreamId >= 0x7fffffff ? 1 : this.nextStreamId + 1
      if (!this.streams.has(candidate)) {
        return candidate
      }
    } while (this.nextStreamId !== start)
    throw new Error('No remote terminal stream ids available.')
  }

  private ensureConnected(): Promise<void> {
    if (this.ready && this.subscription) {
      return Promise.resolve()
    }
    if (this.connectPromise) {
      return this.connectPromise
    }
    const connectPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve
      this.readyRejecter = reject
      void window.api.runtimeEnvironments
        .subscribe(
          {
            selector: this.environmentId,
            method: 'terminal.multiplex',
            params: {},
            timeoutMs: 15_000
          },
          {
            onResponse: (response) => this.handleResponse(response),
            onBinary: (bytes) => this.handleBinary(bytes),
            onError: (error) => this.failConnection(new Error(error.message)),
            onClose: () => this.handleClose('Remote Orca runtime closed the connection.')
          }
        )
        .then((subscription) => {
          if (this.connectPromise !== connectPromise || (!this.ready && !this.readyRejecter)) {
            // Why: close/error can arrive before subscribe() resolves because
            // preload listens before ipcMain.handle() returns. The multiplexer
            // may already be released; do not retain the late handle.
            subscription.unsubscribe()
            return
          }
          this.subscription = subscription
          this.resolveReadyIfConnected()
        })
        .catch((error) => {
          if (this.connectPromise === connectPromise) {
            this.connectPromise = null
            this.readyResolver = null
            this.readyRejecter = null
          }
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
    this.connectPromise = connectPromise
    return this.connectPromise
  }

  private handleResponse(response: RuntimeRpcResponse<unknown>): void {
    let event: TerminalMultiplexEvent
    try {
      event = unwrapRuntimeRpcResult(response) as TerminalMultiplexEvent
    } catch (error) {
      this.failConnection(error instanceof Error ? error : new Error(String(error)))
      return
    }

    if (event.type === 'ready') {
      this.ready = true
      this.resolveReadyIfConnected()
      return
    }

    if (!('streamId' in event) || typeof event.streamId !== 'number') {
      return
    }
    const stream = this.streams.get(event.streamId)
    if (!stream) {
      return
    }
    if (event.type === 'end') {
      clearSnapshot(stream)
      rejectPendingSnapshotRequest(stream, 'Remote terminal stream ended.')
      this.streams.delete(event.streamId)
      stream.callbacks.onEnd?.()
      this.closeIfIdle()
    } else if (event.type === 'error') {
      clearSnapshot(stream)
      rejectPendingSnapshotRequest(
        stream,
        typeof event.message === 'string' ? event.message : 'Remote terminal stream failed.'
      )
      stream.callbacks.onError?.(
        typeof event.message === 'string' ? event.message : 'Remote terminal stream failed.'
      )
    } else if (event.type === 'fit-override-changed') {
      if (
        (event.mode !== 'mobile-fit' && event.mode !== 'desktop-fit') ||
        typeof event.cols !== 'number' ||
        typeof event.rows !== 'number'
      ) {
        return
      }
      stream.callbacks.onFitOverrideChanged?.({
        mode: event.mode,
        cols: event.cols,
        rows: event.rows
      })
    } else if (event.type === 'driver-changed') {
      if (!isTerminalDriverState(event.driver)) {
        return
      }
      stream.callbacks.onDriverChanged?.(event.driver)
    }
  }

  private handleBinary(bytes: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (!stream) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Output) {
      const data = decodeTerminalStreamText(frame.payload)
      stream.callbacks.onData(data, {
        seq: typeof frame.seq === 'number' && frame.seq > 0 ? frame.seq : undefined,
        rawLength: data.length
      })
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
      clearSnapshot(stream)
      stream.snapshotInfo = decodeSnapshotInfo(frame.payload)
      const requestId = stream.snapshotInfo?.requestId
      stream.snapshotTarget =
        typeof requestId === 'number' ||
        (stream.initialSnapshotReceived && stream.pendingSnapshotRequest)
          ? 'request'
          : 'initial'
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
      if (stream.snapshotOverflowed) {
        return
      }
      stream.snapshotBytes += frame.payload.byteLength
      if (stream.snapshotBytes > MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES) {
        stream.snapshotOverflowed = true
        if (stream.snapshotTarget === 'initial') {
          stream.callbacks.onError?.(REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE)
        }
        return
      }
      stream.snapshotChunks.push(frame.payload)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
      const data = stream.snapshotOverflowed
        ? null
        : decodeTerminalStreamText(concatBytes(stream.snapshotChunks))
      const target = stream.snapshotTarget
      const info = stream.snapshotInfo
      const pendingRequest = stream.pendingSnapshotRequest
      const matchesPendingRequest =
        target === 'request' &&
        pendingRequest &&
        (typeof info?.requestId === 'number'
          ? info.requestId === pendingRequest.requestId
          : stream.initialSnapshotReceived)
      if (!stream.snapshotOverflowed && info?.truncated !== true) {
        if (matchesPendingRequest) {
          pendingRequest.resolve({
            data: data ?? '',
            cols: info?.cols ?? 80,
            rows: info?.rows ?? 24,
            seq: info?.seq,
            source: info?.source
          })
          clearPendingSnapshotRequest(stream)
        } else if (target === 'initial') {
          stream.callbacks.onSnapshot(data ?? '')
        }
      } else if (matchesPendingRequest) {
        pendingRequest.resolve(null)
        clearPendingSnapshotRequest(stream)
      }
      clearSnapshot(stream)
      if (target === 'initial') {
        stream.initialSnapshotReceived = true
        stream.callbacks.onSubscribed?.()
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Error) {
      clearSnapshot(stream)
      const pendingSnapshotRequest = stream.pendingSnapshotRequest
      if (pendingSnapshotRequest) {
        clearPendingSnapshotRequest(stream)
        pendingSnapshotRequest.reject(new Error(decodeTerminalStreamText(frame.payload)))
        return
      }
      stream.callbacks.onError?.(decodeTerminalStreamText(frame.payload))
    }
  }

  private requestSnapshot(
    stream: RemoteRuntimeMultiplexedTerminalState,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    source?: 'headless' | 'renderer'
  } | null> {
    if (this.streams.get(stream.streamId) !== stream || !this.ready || !this.subscription) {
      return Promise.resolve(null)
    }
    if (stream.pendingSnapshotRequest) {
      return Promise.reject(new Error('Remote terminal snapshot already in flight.'))
    }
    const requestId = this.allocateSnapshotRequestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (stream.pendingSnapshotRequest?.timer === timer) {
          stream.pendingSnapshotRequest = null
          reject(new Error('Remote terminal snapshot timed out.'))
        }
      }, REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS)
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
      stream.pendingSnapshotRequest = { requestId, resolve, reject, timer }
      if (
        !this.sendFrame(
          stream.streamId,
          TerminalStreamOpcode.SnapshotRequest,
          encodeTerminalStreamJson({ requestId, scrollbackRows: opts?.scrollbackRows })
        )
      ) {
        clearPendingSnapshotRequest(stream)
        resolve(null)
      }
    })
  }

  private allocateSnapshotRequestId(): number {
    const id = this.nextSnapshotRequestId
    this.nextSnapshotRequestId =
      this.nextSnapshotRequestId >= 0x7fffffff ? 1 : this.nextSnapshotRequestId + 1
    return id
  }

  private sendFrame(
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ): boolean {
    if (!this.ready || !this.subscription) {
      return false
    }
    this.subscription.sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: 0, payload }))
    return true
  }

  private resolveReadyIfConnected(): void {
    if (!this.ready || !this.subscription) {
      return
    }
    this.readyResolver?.()
    this.readyResolver = null
    this.readyRejecter = null
  }

  private failConnection(error: Error): void {
    this.readyRejecter?.(error)
    this.readyResolver = null
    this.readyRejecter = null
    for (const stream of this.streams.values()) {
      stream.callbacks.onError?.(error.message)
    }
    this.subscription?.unsubscribe()
    this.handleClose()
  }

  private handleClose(message?: string): void {
    const streams = Array.from(this.streams.values())
    this.ready = false
    this.connectPromise = null
    this.readyRejecter?.(new Error(message ?? 'Remote runtime connection closed.'))
    this.readyResolver = null
    this.readyRejecter = null
    this.subscription = null
    this.streams.clear()
    for (const stream of streams) {
      clearSnapshot(stream)
      rejectPendingSnapshotRequest(stream, message ?? 'Remote runtime connection closed.')
      const canHandleClose = Boolean(stream.callbacks.onTransportClose)
      stream.callbacks.onTransportClose?.()
      if (message && !canHandleClose) {
        stream.callbacks.onError?.(message)
      }
    }
    // Why: a closed transport has no live streams or subscription; keeping it
    // in the module map only retains callbacks for an environment that must
    // reconnect through a fresh subscription anyway.
    this.releaseIfCurrent(this.environmentId, this)
  }

  private closeIfIdle(): void {
    if (this.streams.size > 0) {
      return
    }
    this.subscription?.unsubscribe()
    this.subscription = null
    this.connectPromise = null
    this.ready = false
    this.releaseIfCurrent(this.environmentId, this)
  }
}

const multiplexers = new Map<string, RemoteRuntimeTerminalMultiplexer>()

function releaseRemoteRuntimeTerminalMultiplexer(
  environmentId: string,
  multiplexer: RemoteRuntimeTerminalMultiplexer
): void {
  if (multiplexers.get(environmentId) === multiplexer) {
    multiplexers.delete(environmentId)
  }
}

export function getRemoteRuntimeTerminalMultiplexer(
  environmentId: string
): RemoteRuntimeTerminalMultiplexer {
  let multiplexer = multiplexers.get(environmentId)
  if (!multiplexer) {
    multiplexer = new RemoteRuntimeTerminalMultiplexer(
      environmentId,
      releaseRemoteRuntimeTerminalMultiplexer
    )
    multiplexers.set(environmentId, multiplexer)
  }
  return multiplexer
}

export function _getRemoteRuntimeTerminalMultiplexerCountForTest(): number {
  return multiplexers.size
}

export function resetRemoteRuntimeTerminalMultiplexersForTests(): void {
  multiplexers.clear()
}

function concatBytes(chunks: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function clearSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
  stream.snapshotChunks = []
  stream.snapshotBytes = 0
  stream.snapshotOverflowed = false
  stream.snapshotTarget = 'initial'
  stream.snapshotInfo = null
}

function clearPendingSnapshotRequest(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const request = stream.pendingSnapshotRequest
  stream.pendingSnapshotRequest = null
  if (request) {
    clearTimeout(request.timer)
  }
}

function rejectPendingSnapshotRequest(
  stream: RemoteRuntimeMultiplexedTerminalState,
  message: string
): void {
  const request = stream.pendingSnapshotRequest
  if (!request) {
    return
  }
  clearPendingSnapshotRequest(stream)
  request.reject(new Error(message))
}

function decodeSnapshotInfo(
  payload: Uint8Array<ArrayBufferLike>
): RemoteRuntimeSnapshotInfo | null {
  const raw = decodeTerminalStreamJson<{
    cols?: unknown
    rows?: unknown
    seq?: unknown
    source?: unknown
    requestId?: unknown
    truncated?: unknown
  }>(payload)
  if (!raw) {
    return null
  }
  return {
    cols: typeof raw.cols === 'number' ? raw.cols : undefined,
    rows: typeof raw.rows === 'number' ? raw.rows : undefined,
    seq: typeof raw.seq === 'number' ? raw.seq : undefined,
    source: raw.source === 'headless' || raw.source === 'renderer' ? raw.source : undefined,
    requestId: typeof raw.requestId === 'number' ? raw.requestId : undefined,
    truncated: raw.truncated === true
  }
}

function isTerminalDriverState(
  value: unknown
): value is { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string } {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return false
  }
  const driver = value as { kind?: unknown; clientId?: unknown }
  return (
    driver.kind === 'idle' ||
    driver.kind === 'desktop' ||
    (driver.kind === 'mobile' && typeof driver.clientId === 'string')
  )
}
