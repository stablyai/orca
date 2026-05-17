/* eslint-disable max-lines -- Why: the remote terminal multiplexer owns one bridged subscription, stream lifecycle, binary frame parsing, and remote lock events as a single transport contract. */
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
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
  onData: (data: string) => void
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
  close: () => void
}

type RemoteRuntimeMultiplexedTerminalState = {
  streamId: number
  terminal: string
  callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  snapshotChunks: Uint8Array<ArrayBufferLike>[]
  snapshotBytes: number
  snapshotOverflowed: boolean
}

const CONTROL_STREAM_ID = 0
const MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024
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

  constructor(private readonly environmentId: string) {}

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
      snapshotOverflowed: false
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
      close: () => {
        if (this.streams.get(streamId) === state) {
          this.sendFrame(streamId, TerminalStreamOpcode.Unsubscribe)
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
    this.connectPromise = new Promise<void>((resolve, reject) => {
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
          this.subscription = subscription
          this.resolveReadyIfConnected()
        })
        .catch((error) => {
          this.connectPromise = null
          this.readyResolver = null
          this.readyRejecter = null
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
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
      this.streams.delete(event.streamId)
      stream.callbacks.onEnd?.()
      this.closeIfIdle()
    } else if (event.type === 'error') {
      clearSnapshot(stream)
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
      stream.callbacks.onData(decodeTerminalStreamText(frame.payload))
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
      clearSnapshot(stream)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
      if (stream.snapshotOverflowed) {
        return
      }
      stream.snapshotBytes += frame.payload.byteLength
      if (stream.snapshotBytes > MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES) {
        clearSnapshot(stream)
        stream.snapshotOverflowed = true
        stream.callbacks.onError?.(REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE)
        return
      }
      stream.snapshotChunks.push(frame.payload)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
      if (!stream.snapshotOverflowed) {
        stream.callbacks.onSnapshot(decodeTerminalStreamText(concatBytes(stream.snapshotChunks)))
      }
      clearSnapshot(stream)
      stream.callbacks.onSubscribed?.()
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Error) {
      clearSnapshot(stream)
      stream.callbacks.onError?.(decodeTerminalStreamText(frame.payload))
    }
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
      stream.callbacks.onTransportClose?.()
      if (message) {
        stream.callbacks.onError?.(message)
      }
    }
  }

  private closeIfIdle(): void {
    if (this.streams.size > 0) {
      return
    }
    this.subscription?.unsubscribe()
    this.subscription = null
    this.connectPromise = null
    this.ready = false
  }
}

const multiplexers = new Map<string, RemoteRuntimeTerminalMultiplexer>()

export function getRemoteRuntimeTerminalMultiplexer(
  environmentId: string
): RemoteRuntimeTerminalMultiplexer {
  let multiplexer = multiplexers.get(environmentId)
  if (!multiplexer) {
    multiplexer = new RemoteRuntimeTerminalMultiplexer(environmentId)
    multiplexers.set(environmentId, multiplexer)
  }
  return multiplexer
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
