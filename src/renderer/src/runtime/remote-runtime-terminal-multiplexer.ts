/* eslint-disable max-lines -- Why: the remote terminal multiplexer owns one bridged subscription, stream lifecycle, binary frame parsing, and remote lock events as a single transport contract. */
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../shared/remote-runtime-client-error-classification'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { e2eConfig } from '@/lib/e2e-config'
import { deliverTerminalDataWithDeferredCredit } from '@/lib/pane-manager/terminal-delivery-credit'
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
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
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
  onData: (data: string, meta?: { seq?: number; rawLength?: number; transformed?: boolean }) => void
  onSnapshot: (data: string, meta?: { pendingEscapeTailAnsi?: string }) => void
  onSubscribed?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
  onFitOverrideChanged?: (event: {
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
    cols: number
    rows: number
  }) => void
  onDriverChanged?: (
    driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
  ) => void
  onTransportClose?: (event: { recoverable: boolean }) => void
}

export type RemoteRuntimeMultiplexedTerminal = {
  streamId: number
  sendInput: (text: string) => boolean
  resize: (cols: number, rows: number) => boolean
  claimViewport: (cols: number, rows: number) => boolean
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
  subscriptionRequested: boolean
  acknowledgeOutput: boolean
  heldAckBytes: number
  snapshotChunks: Uint8Array<ArrayBufferLike>[]
  snapshotBytes: number
  snapshotOverflowed: boolean
  snapshotTarget: 'initial' | 'request' | 'recovery'
  snapshotInfo: RemoteRuntimeSnapshotInfo | null
  initialSnapshotReceived: boolean
  pendingSnapshotRequest: RemoteRuntimeSnapshotRequest | null
  // Why: Output frames carry a UTF-16 offset high-water `seq`; a jump past the
  // expected next offset means the server dropped frames under backpressure.
  // Track it so a gap triggers a self-healing snapshot resync instead of
  // silently rendering corrupt/missing output (frame-drop resync).
  expectedSeq: number | undefined
  resyncInFlight: boolean
  resyncPendingSend: boolean
}

type RemoteRuntimeSnapshotInfo = {
  cols?: number
  rows?: number
  seq?: number
  source?: 'headless' | 'renderer'
  requestId?: number
  truncated?: boolean
  // Why: a mid-escape tail the emulator could not serialize; the transport
  // must write it AFTER the replay reset so the next live chunk completes it
  // instead of rendering literally (#7329).
  pendingEscapeTailAnsi?: string
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
      pendingEscapeTailAnsi?: string
    } | null
  ) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CONTROL_STREAM_ID = 0
const MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024
const REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000
// Why: exported so the transport can classify it as benign — the snapshot was
// skipped but live output continues, so it must not surface a fatal red banner.
export const REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE =
  'Remote terminal snapshot exceeded the 2 MiB replay limit; live output will continue.'

type E2eRemoteTerminalMultiplexAckGateSnapshot = {
  heldTerminalCount: number
  heldStreamCount: number
  heldAckChars: number
  releasedAckChars: number
}

type E2eRemoteTerminalMultiplexAckGateApi = {
  hold: (terminals: string[]) => void
  release: () => void
  snapshot: () => E2eRemoteTerminalMultiplexAckGateSnapshot
}

type E2eRemoteTerminalMultiplexAckGateWindow = Window & {
  __remoteTerminalMultiplexAckGate?: E2eRemoteTerminalMultiplexAckGateApi
}

const e2eHeldRemoteAckTerminals = new Set<string>()
let e2eReleasedRemoteAckChars = 0

function shouldHoldE2eRemoteTerminalAck(terminal: string): boolean {
  return e2eConfig.exposeStore && e2eHeldRemoteAckTerminals.has(terminal)
}

function getE2eRemoteAckSnapshot(): E2eRemoteTerminalMultiplexAckGateSnapshot {
  let heldStreamCount = 0
  let heldAckChars = 0
  for (const multiplexer of multiplexers.values()) {
    for (const stream of multiplexer.getStreamsForE2e()) {
      if (stream.heldAckBytes > 0) {
        heldStreamCount += 1
        heldAckChars += stream.heldAckBytes
      }
    }
  }
  return {
    heldTerminalCount: e2eHeldRemoteAckTerminals.size,
    heldStreamCount,
    heldAckChars,
    releasedAckChars: e2eReleasedRemoteAckChars
  }
}

function releaseE2eRemoteTerminalAcks(): void {
  for (const multiplexer of multiplexers.values()) {
    e2eReleasedRemoteAckChars += multiplexer.releaseHeldAcksForE2e()
  }
  e2eHeldRemoteAckTerminals.clear()
}

function exposeE2eRemoteTerminalMultiplexAckGate(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as E2eRemoteTerminalMultiplexAckGateWindow
  target.__remoteTerminalMultiplexAckGate ??= {
    hold: (terminals) => {
      releaseE2eRemoteTerminalAcks()
      for (const terminal of terminals) {
        e2eHeldRemoteAckTerminals.add(terminal)
      }
    },
    release: releaseE2eRemoteTerminalAcks,
    snapshot: getE2eRemoteAckSnapshot
  }
}

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
      subscriptionRequested: false,
      acknowledgeOutput: args.client.type === 'desktop',
      heldAckBytes: 0,
      snapshotChunks: [],
      snapshotBytes: 0,
      snapshotOverflowed: false,
      snapshotTarget: 'initial',
      snapshotInfo: null,
      initialSnapshotReceived: false,
      pendingSnapshotRequest: null,
      expectedSeq: undefined,
      resyncInFlight: false,
      resyncPendingSend: false
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
      claimViewport: (cols, rows) => {
        const claimed = this.sendFrame(
          streamId,
          TerminalStreamOpcode.ClaimViewport,
          encodeTerminalStreamJson({ cols, rows })
        )
        // Why: older runtimes ignore the claim opcode but still understand
        // Resize. Claim first keeps new-runtime ownership precise and leaves a
        // backwards-compatible resize immediately behind it.
        const resized = this.sendFrame(
          streamId,
          TerminalStreamOpcode.Resize,
          encodeTerminalStreamJson({ cols, rows })
        )
        return claimed && resized
      },
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
          viewport: args.viewport,
          capabilities:
            args.client.type === 'desktop' ? { ackOutput: 1, desktopViewportClaims: 1 } : undefined
        })
      )
      if (!sent) {
        throw new Error('Remote terminal stream is not connected.')
      }
      state.subscriptionRequested = true
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
            onError: (error) => {
              if (isRecoverableRemoteRuntimeConnectionError(error)) {
                this.handleClose(error.message)
              } else {
                this.failConnection(Object.assign(new Error(error.message), { code: error.code }))
              }
            },
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
        (event.mode !== 'mobile-fit' &&
          event.mode !== 'remote-desktop-fit' &&
          event.mode !== 'desktop-fit') ||
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
    if (
      frame.opcode === TerminalStreamOpcode.Output ||
      frame.opcode === TerminalStreamOpcode.OutputSpan
    ) {
      const span =
        frame.opcode === TerminalStreamOpcode.OutputSpan
          ? decodeTerminalStreamJson<{
              data?: unknown
              rawLength?: unknown
              transformed?: unknown
            }>(frame.payload)
          : null
      const validSpan =
        frame.opcode !== TerminalStreamOpcode.OutputSpan ||
        (typeof span?.data === 'string' &&
          typeof span.rawLength === 'number' &&
          Number.isSafeInteger(span.rawLength) &&
          span.rawLength >= 0 &&
          span.transformed === true)
      const data =
        frame.opcode === TerminalStreamOpcode.OutputSpan
          ? validSpan
            ? (span!.data as string)
            : ''
          : decodeTerminalStreamText(frame.payload)
      const deliverOutput = (): void => {
        if (!validSpan) {
          // Why: rendering malformed span JSON would expose protocol framing
          // as terminal text and lose its raw sequence accounting.
          this.requestResyncSnapshot(stream)
          return
        }
        const rawLength =
          frame.opcode === TerminalStreamOpcode.OutputSpan && typeof span?.rawLength === 'number'
            ? span.rawLength
            : data.length
        // Why: a resync snapshot is authoritative; discard live output while
        // it is in flight, but still return transport credit in finally.
        if (stream.resyncInFlight) {
          return
        }
        const seq = typeof frame.seq === 'number' && frame.seq > 0 ? frame.seq : undefined
        if (this.detectOutputGap(stream, seq, rawLength)) {
          this.requestResyncSnapshot(stream)
          return
        }
        if (typeof seq === 'number') {
          stream.expectedSeq = seq
        }
        stream.callbacks.onData(data, {
          seq,
          rawLength,
          ...(frame.opcode === TerminalStreamOpcode.OutputSpan ? { transformed: true } : {})
        })
      }
      if (!stream.acknowledgeOutput) {
        deliverOutput()
        return
      }
      deliverTerminalDataWithDeferredCredit(() => {
        if (shouldHoldE2eRemoteTerminalAck(stream.terminal)) {
          stream.heldAckBytes += frame.payload.byteLength
        } else {
          this.acknowledgeOutput(stream, frame.payload.byteLength)
        }
      }, deliverOutput)
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
          : stream.initialSnapshotReceived
            ? 'recovery'
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
            source: info?.source,
            pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi
          })
          clearPendingSnapshotRequest(stream)
        } else if (target === 'initial') {
          stream.callbacks.onSnapshot(data ?? '', {
            pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi
          })
        } else if (target === 'recovery') {
          // Why: a server-pushed recovery snapshot replaces terminal state
          // mid-session; clear the screen and scrollback before applying it.
          // An empty snapshot is still applied so stale dropped output does
          // not linger on a terminal the model says is blank.
          stream.callbacks.onSnapshot(`\x1b[2J\x1b[3J\x1b[H${data ?? ''}`, {
            pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi
          })
        }
      } else if (matchesPendingRequest) {
        pendingRequest.resolve(null)
        clearPendingSnapshotRequest(stream)
      }
      clearSnapshot(stream)
      // Why: the snapshot is the new authoritative output high-water; align the
      // gap detector to it and re-open the live path (used by both the initial
      // snapshot and a frame-drop resync, which reuses the 'initial' target).
      if (target === 'initial') {
        stream.expectedSeq = typeof info?.seq === 'number' ? info.seq : undefined
        stream.resyncInFlight = false
        stream.resyncPendingSend = false
        stream.initialSnapshotReceived = true
        stream.callbacks.onSubscribed?.()
      } else {
        this.sendDeferredResyncSnapshot(stream)
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Error) {
      clearSnapshot(stream)
      const pendingSnapshotRequest = stream.pendingSnapshotRequest
      if (pendingSnapshotRequest) {
        clearPendingSnapshotRequest(stream)
        pendingSnapshotRequest.reject(new Error(decodeTerminalStreamText(frame.payload)))
        this.sendDeferredResyncSnapshot(stream)
        return
      }
      // Why: a failed resync must re-open the live path or output stalls forever.
      stream.resyncInFlight = false
      stream.resyncPendingSend = false
      stream.callbacks.onError?.(decodeTerminalStreamText(frame.payload))
    }
  }

  // Why: Output `seq` is the UTF-16 high-water at the end of a chunk, so a chunk
  // that begins after the last high-water (startSeq > expectedSeq) means the
  // server dropped intervening frames under backpressure. Only flag a gap when
  // both offsets are known, and never on the first seq (nothing to compare to).
  private detectOutputGap(
    stream: RemoteRuntimeMultiplexedTerminalState,
    seq: number | undefined,
    rawLength: number
  ): boolean {
    if (typeof seq !== 'number' || typeof stream.expectedSeq !== 'number') {
      return false
    }
    const startSeq = seq - rawLength
    return startSeq > stream.expectedSeq
  }

  // Why: on a detected gap, discard the corrupt tail and pull a fresh
  // authoritative snapshot. The request carries no requestId so the server
  // reply renders through the initial-snapshot path (full reset), self-healing
  // without surfacing an error to the user.
  private requestResyncSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
    if (stream.resyncInFlight) {
      return
    }
    stream.resyncInFlight = true
    stream.expectedSeq = undefined
    if (stream.pendingSnapshotRequest) {
      // Why: snapshot frame groups are not multiplexed; wait for the manual
      // snapshot to finish so its response cannot be mistaken for recovery.
      stream.resyncPendingSend = true
      return
    }
    this.sendResyncSnapshot(stream)
  }

  private sendDeferredResyncSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
    if (!stream.resyncInFlight || !stream.resyncPendingSend || stream.pendingSnapshotRequest) {
      return
    }
    this.sendResyncSnapshot(stream)
  }

  private sendResyncSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
    stream.resyncPendingSend = false
    const sent = this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.SnapshotRequest,
      encodeTerminalStreamJson({ scrollbackRows: undefined })
    )
    if (!sent) {
      // Transport is down; the reconnect path re-subscribes from scratch.
      stream.resyncInFlight = false
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
    // Recovery uses an untagged snapshot frame group; callers can retry after
    // it completes instead of racing another request onto the same frame lane.
    if (stream.resyncInFlight) {
      return Promise.resolve(null)
    }
    if (stream.pendingSnapshotRequest) {
      return Promise.reject(new Error('Remote terminal snapshot already in flight.'))
    }
    const requestId = this.allocateSnapshotRequestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (stream.pendingSnapshotRequest?.timer === timer) {
          clearPendingSnapshotRequest(stream)
          reject(new Error('Remote terminal snapshot timed out.'))
          this.sendDeferredResyncSnapshot(stream)
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

  private acknowledgeOutput(stream: RemoteRuntimeMultiplexedTerminalState, bytes: number): boolean {
    return this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.Ack,
      encodeTerminalStreamJson({ bytes })
    )
  }

  getStreamsForE2e(): Iterable<RemoteRuntimeMultiplexedTerminalState> {
    return this.streams.values()
  }

  releaseHeldAcksForE2e(): number {
    let released = 0
    for (const stream of this.streams.values()) {
      if (stream.heldAckBytes <= 0) {
        continue
      }
      const bytes = stream.heldAckBytes
      stream.heldAckBytes = 0
      if (this.acknowledgeOutput(stream, bytes)) {
        released += bytes
      }
    }
    return released
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
      // Why: a stream still awaiting ensureConnected receives this failure through its rejected promise.
      if (stream.subscriptionRequested) {
        stream.callbacks.onError?.(error.message)
      }
    }
    this.handleClose(undefined, false)
  }

  private handleClose(message?: string, recoverable = true): void {
    const streams = Array.from(this.streams.values())
    const closingSubscription = this.subscription
    this.ready = false
    this.connectPromise = null
    this.readyRejecter?.(new Error(message ?? 'Remote runtime connection closed.'))
    this.readyResolver = null
    this.readyRejecter = null
    this.subscription = null
    closingSubscription?.unsubscribe()
    this.streams.clear()
    // Why: close callbacks may resubscribe synchronously; release first so every replacement shares the new environment multiplexer.
    this.releaseIfCurrent(this.environmentId, this)
    for (const stream of streams) {
      clearSnapshot(stream)
      rejectPendingSnapshotRequest(stream, message ?? 'Remote runtime connection closed.')
      const canHandleClose = Boolean(stream.callbacks.onTransportClose)
      stream.callbacks.onTransportClose?.({ recoverable })
      if (message && !canHandleClose) {
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
  exposeE2eRemoteTerminalMultiplexAckGate()
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
  e2eHeldRemoteAckTerminals.clear()
  e2eReleasedRemoteAckChars = 0
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
    pendingEscapeTailAnsi?: unknown
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
    truncated: raw.truncated === true,
    pendingEscapeTailAnsi:
      typeof raw.pendingEscapeTailAnsi === 'string' ? raw.pendingEscapeTailAnsi : undefined
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
