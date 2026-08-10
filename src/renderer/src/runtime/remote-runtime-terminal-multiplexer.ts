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
import {
  parseTerminalSnapshotUnavailableReason,
  type TerminalSnapshotUnavailableReason
} from '../../../shared/terminal-snapshot-unavailability'
import { e2eConfig, e2eDisableRemoteTerminalStallRecovery } from '@/lib/e2e-config'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { deliverTerminalDataWithDeferredCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_ACK_FLUSH_MS,
  TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR
} from '../../../shared/terminal-multiplex-flow-control'
import {
  createRemoteTerminalStreamWatchdog,
  type RemoteTerminalStreamWatchdog
} from './remote-terminal-stream-watchdog'

type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

type TerminalMultiplexEvent =
  | { type: 'ready' }
  | {
      type: 'subscribed'
      streamId: number
      streamGeneration?: string
      capabilities?: { ackOutputSourceRanges?: 1; outputPause?: 1 }
    }
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
  onSnapshot: (
    data: string,
    meta?: { cols?: number; rows?: number; pendingEscapeTailAnsi?: string }
  ) => void
  onSubscribed?: () => void
  onOutputPauseCapability?: () => void
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
  onWriteUnavailable?: () => void
  onTransportClose?: (event: { recoverable: boolean; retryWithBackoff?: boolean }) => void
}

export type RemoteRuntimeSnapshotImage = {
  data: string
  cols: number
  rows: number
  seq?: number
  source?: 'headless' | 'renderer'
  pendingEscapeTailAnsi?: string
}

/** Transient causes the host itself reported: a request reached it and it declined to serialize now. */
export type RemoteRuntimeSnapshotHostRetryCause =
  | 'host-pending-output-overflowed'
  | 'host-no-serializable-buffer'

/** Transient causes decided entirely client-side: no request frame ever reached the host, so it answered nothing. */
export type RemoteRuntimeSnapshotLocalRetryCause =
  | 'resync-in-flight'
  | 'stream-detached'
  | 'connection-not-ready'
  | 'request-already-in-flight'
  | 'request-frame-not-sent'

/** Transient causes: the same request may succeed later, so an absent buffer proves nothing about the pane. */
export type RemoteRuntimeSnapshotRetryCause =
  | RemoteRuntimeSnapshotHostRetryCause
  | RemoteRuntimeSnapshotLocalRetryCause

const HOST_ANSWERED_SNAPSHOT_RETRY_CAUSES = new Set<RemoteRuntimeSnapshotRetryCause>([
  'host-pending-output-overflowed',
  'host-no-serializable-buffer'
])

/** Callers budget host answers separately from local gates; only the former cost the host a request. */
export function isHostAnsweredSnapshotRetryCause(
  cause: RemoteRuntimeSnapshotRetryCause
): cause is RemoteRuntimeSnapshotHostRetryCause {
  return HOST_ANSWERED_SNAPSHOT_RETRY_CAUSES.has(cause)
}

/** Final causes: the host answered and repeating this exact request cannot produce the buffer. */
export type RemoteRuntimeSnapshotPermanentReason = 'exceeds-client-replay-limit'

export type RemoteRuntimeSnapshotAvailability =
  | { kind: 'snapshot' }
  | { kind: 'permanently-unavailable'; reason: RemoteRuntimeSnapshotPermanentReason }
  | { kind: 'retry-worthy'; cause: RemoteRuntimeSnapshotRetryCause }
  // Why: a pre-`unavailable` host sent an empty reply with no reason; the caller must fall back to its own heuristic.
  | { kind: 'unknown-legacy-host' }

/**
 * `availability` is what the reply proves; `snapshot` is the buffer image the host actually sent.
 * They are orthogonal so legacy callers can keep reading `snapshot` alone while new callers read the reason.
 */
export type RemoteRuntimeSnapshotOutcome = {
  availability: RemoteRuntimeSnapshotAvailability
  snapshot: RemoteRuntimeSnapshotImage | null
}

export type RemoteRuntimeMultiplexedTerminal = {
  streamId: number
  sendInput: (text: string) => boolean
  resize: (cols: number, rows: number) => boolean
  claimViewport: (cols: number, rows: number) => boolean
  setOutputPaused: (paused: boolean) => boolean
  serializeBuffer: (opts?: { scrollbackRows?: number }) => Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    source?: 'headless' | 'renderer'
  } | null>
  // Why: same request as serializeBuffer, but keeps the host's reason for an absent buffer instead of collapsing it to null.
  serializeBufferOutcome: (opts?: {
    scrollbackRows?: number
  }) => Promise<RemoteRuntimeSnapshotOutcome>
  close: () => void
}

type RemoteRuntimeMultiplexedTerminalState = {
  streamId: number
  terminal: string
  callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  subscriptionRequested: boolean
  acknowledgeOutput: boolean
  acknowledgeOutputSourceRanges: boolean
  supportsOutputPause: boolean
  outputPaused: boolean
  streamGeneration: string | null
  sourceAckedEndByte: number
  heldAckBytes: number
  pendingAckBytes: number
  ackFlushTimer: ReturnType<typeof setTimeout> | null
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
  // Why: compare command probes when initial/live frames supplied no high-water.
  commandProbeBaselineSeq: number | undefined
  recoverySnapshotSeq: number | undefined
  resyncInFlight: boolean
  resyncPendingSend: boolean
  resyncTimer: ReturnType<typeof setTimeout> | null
  resyncAttempts: number
  capacityRejected: boolean
  watchdog: RemoteTerminalStreamWatchdog
}

type RemoteRuntimeSnapshotInfo = {
  cols?: number
  rows?: number
  seq?: number
  source?: 'headless' | 'renderer'
  requestId?: number
  truncated?: boolean
  unavailable?: TerminalSnapshotUnavailableReason
  // Why: a mid-escape tail the emulator could not serialize; the transport
  // must write it AFTER the replay reset so the next live chunk completes it
  // instead of rendering literally (#7329).
  pendingEscapeTailAnsi?: string
}

type RemoteRuntimeSnapshotRequest = {
  requestId: number
  resolve: (outcome: RemoteRuntimeSnapshotOutcome) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CONTROL_STREAM_ID = 0
const MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000
const REMOTE_TERMINAL_RESYNC_TIMEOUT_MS = 10_000
// Why: a truncated recovery means the server is too flooded to serialize;
// retrying once per incoming chunk would stampede it, so back off instead.
const REMOTE_TERMINAL_RESYNC_RETRY_BASE_MS = 500
const REMOTE_TERMINAL_RESYNC_RETRY_MAX_MS = 5_000
// Why: exported so the transport can classify it as benign — the snapshot was
// skipped but live output continues, so it must not surface a fatal red banner.
export const REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE =
  'Remote terminal snapshot exceeded the 2 MiB replay limit; live output will continue.'

type E2eRemoteTerminalMultiplexAckGateSnapshot = {
  droppedOutputBytes: number
  droppedOutputFrames: number
  heldTerminalCount: number
  heldStreamCount: number
  heldAckChars: number
  releasedAckChars: number
}

type E2eRemoteTerminalMultiplexAckGateApi = {
  dropOutputUntilResubscribe: (terminals: string[]) => number
  forceError: (terminals: string[], message: string) => number
  hold: (terminals: string[]) => void
  holdEnd: (terminals: string[]) => void
  release: () => void
  sendInput: (terminal: string, text: string) => number
  snapshot: () => E2eRemoteTerminalMultiplexAckGateSnapshot
}

type E2eRemoteTerminalMultiplexAckGateWindow = Window & {
  __remoteTerminalMultiplexAckGate?: E2eRemoteTerminalMultiplexAckGateApi
}

const e2eHeldRemoteAckTerminals = new Set<string>()
const e2eHeldRemoteEndTerminals = new Set<string>()
const e2eDroppedOutputStreams = new Set<RemoteRuntimeMultiplexedTerminalState>()
let e2eDroppedOutputBytes = 0
let e2eDroppedOutputFrames = 0
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
    droppedOutputBytes: e2eDroppedOutputBytes,
    droppedOutputFrames: e2eDroppedOutputFrames,
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

function resetE2eDroppedRemoteOutput(): void {
  e2eDroppedOutputStreams.clear()
  e2eDroppedOutputBytes = 0
  e2eDroppedOutputFrames = 0
}

function shouldDropE2eRemoteTerminalOutput(
  stream: RemoteRuntimeMultiplexedTerminalState,
  bytes: number
): boolean {
  if (!e2eConfig.exposeStore || !e2eDroppedOutputStreams.has(stream)) {
    return false
  }
  e2eDroppedOutputBytes += bytes
  e2eDroppedOutputFrames += 1
  return true
}

function exposeE2eRemoteTerminalMultiplexAckGate(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as E2eRemoteTerminalMultiplexAckGateWindow
  target.__remoteTerminalMultiplexAckGate ??= {
    dropOutputUntilResubscribe: (terminals) => {
      resetE2eDroppedRemoteOutput()
      const targets = new Set(terminals)
      for (const multiplexer of multiplexers.values()) {
        for (const stream of multiplexer.getStreamsForE2e()) {
          if (targets.has(stream.terminal)) {
            e2eDroppedOutputStreams.add(stream)
          }
        }
      }
      return e2eDroppedOutputStreams.size
    },
    forceError: (terminals, message) => {
      let dispatched = 0
      const targets = new Set(terminals)
      for (const multiplexer of multiplexers.values()) {
        dispatched += multiplexer.forceErrorForE2e(targets, message)
      }
      return dispatched
    },
    hold: (terminals) => {
      releaseE2eRemoteTerminalAcks()
      for (const terminal of terminals) {
        e2eHeldRemoteAckTerminals.add(terminal)
      }
    },
    holdEnd: (terminals) => {
      e2eHeldRemoteEndTerminals.clear()
      for (const terminal of terminals) {
        e2eHeldRemoteEndTerminals.add(terminal)
      }
    },
    release: () => {
      releaseE2eRemoteTerminalAcks()
      resetE2eDroppedRemoteOutput()
      e2eHeldRemoteEndTerminals.clear()
    },
    sendInput: (terminal, value) => {
      let sent = 0
      for (const multiplexer of multiplexers.values()) {
        sent += multiplexer.sendInputForE2e(terminal, value)
      }
      return sent
    },
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
    private readonly environmentRevision: number | undefined,
    private readonly releaseIfCurrent: (
      environmentId: string,
      multiplexer: RemoteRuntimeTerminalMultiplexer
    ) => void
  ) {}

  matchesCurrentEnvironmentRevision(): boolean {
    return getRuntimeEnvironmentRevision(this.environmentId) === this.environmentRevision
  }

  closeForEnvironmentReplacement(): void {
    this.handleClose('Runtime environment pairing changed.')
  }

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
      acknowledgeOutput: true,
      acknowledgeOutputSourceRanges: false,
      supportsOutputPause: false,
      outputPaused: false,
      streamGeneration: null,
      sourceAckedEndByte: 0,
      heldAckBytes: 0,
      pendingAckBytes: 0,
      ackFlushTimer: null,
      snapshotChunks: [],
      snapshotBytes: 0,
      snapshotOverflowed: false,
      snapshotTarget: 'initial',
      snapshotInfo: null,
      initialSnapshotReceived: false,
      pendingSnapshotRequest: null,
      expectedSeq: undefined,
      commandProbeBaselineSeq: undefined,
      recoverySnapshotSeq: undefined,
      resyncInFlight: false,
      resyncPendingSend: false,
      resyncTimer: null,
      resyncAttempts: 0,
      capacityRejected: false,
      watchdog: createRemoteTerminalStreamWatchdog((stall) => {
        if (e2eDisableRemoteTerminalStallRecovery) {
          state.watchdog.completeCommandResponseProbe()
          return
        }
        recordRendererCrashBreadcrumb('remote_terminal_stream_stall_recovery', {
          environmentId: this.environmentId,
          expectedSeq: state.expectedSeq ?? null,
          inactiveForMs: stall.inactiveForMs,
          outstandingDeliveryBytes: stall.outstandingDeliveryBytes,
          pendingAckBytes: state.pendingAckBytes,
          reason: stall.reason,
          resyncAttempts: state.resyncAttempts,
          snapshotPending: state.pendingSnapshotRequest !== null,
          streamId: state.streamId,
          terminal: state.terminal
        })
        if (stall.reason === 'command-response-timeout') {
          this.probeCommandResponse(state)
        } else {
          this.recoverStalledStream(state)
        }
      })
    }
    this.streams.set(streamId, state)

    const stream: RemoteRuntimeMultiplexedTerminal = {
      streamId,
      sendInput: (text) => this.sendInput(state, text),
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
      setOutputPaused: (paused) => this.setOutputPaused(state, paused),
      serializeBuffer: (opts) => this.requestSnapshot(state, opts),
      serializeBufferOutcome: (opts) => this.requestSnapshotOutcome(state, opts),
      close: () => {
        if (this.streams.get(streamId) === state) {
          discardOutputAcknowledgements(state)
          state.watchdog.dispose()
          this.sendFrame(streamId, TerminalStreamOpcode.Unsubscribe)
          clearResyncTimer(state)
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
          capabilities: {
            ackOutput: 1,
            ackOutputSourceRanges: 1,
            outputPause: 1,
            writeUnavailable: 1,
            ...(args.client.type === 'desktop' ? { desktopViewportClaims: 1 } : {})
          }
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
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision: this.environmentRevision
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
    if (!this.matchesCurrentEnvironmentRevision()) {
      this.closeForEnvironmentReplacement()
      return
    }
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
    stream.watchdog.recordInbound()
    if (
      event.type === 'end' &&
      e2eConfig.exposeStore &&
      e2eHeldRemoteEndTerminals.has(stream.terminal)
    ) {
      return
    }
    if (event.type === 'subscribed') {
      const capabilities =
        typeof event.capabilities === 'object' && event.capabilities !== null
          ? (event.capabilities as { ackOutputSourceRanges?: unknown; outputPause?: unknown })
          : null
      if (
        capabilities?.ackOutputSourceRanges === 1 &&
        typeof event.streamGeneration === 'string' &&
        event.streamGeneration.length > 0
      ) {
        stream.acknowledgeOutputSourceRanges = true
        stream.streamGeneration = event.streamGeneration
      }
      stream.supportsOutputPause = capabilities?.outputPause === 1
      if (stream.supportsOutputPause) {
        stream.callbacks.onOutputPauseCapability?.()
      }
    } else if (event.type === 'end') {
      discardOutputAcknowledgements(stream)
      stream.watchdog.dispose()
      clearSnapshot(stream)
      clearResyncTimer(stream)
      rejectPendingSnapshotRequest(stream, 'Remote terminal stream ended.')
      this.streams.delete(event.streamId)
      if (stream.capacityRejected) {
        if (stream.callbacks.onTransportClose) {
          stream.callbacks.onTransportClose({ recoverable: true, retryWithBackoff: true })
        } else {
          stream.callbacks.onError?.(TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR)
        }
      } else {
        stream.callbacks.onEnd?.()
      }
      this.closeIfIdle()
    } else if (event.type === 'error') {
      const message =
        typeof event.message === 'string' ? event.message : 'Remote terminal stream failed.'
      if (message === TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR) {
        stream.capacityRejected = true
        return
      }
      clearSnapshot(stream)
      rejectPendingSnapshotRequest(stream, message)
      // Why: the paired binary Error frame can be dropped under backpressure;
      // this reliable event must also dispatch or release the resync gate, and
      // must never disarm the watchdog while leaving the gate shut.
      if (stream.resyncPendingSend) {
        this.sendDeferredResyncSnapshot(stream)
      } else {
        clearResyncTimer(stream)
        stream.resyncInFlight = false
      }
      stream.callbacks.onError?.(message)
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
    if (!this.matchesCurrentEnvironmentRevision()) {
      this.closeForEnvironmentReplacement()
      return
    }
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      // Why: malformed framing cannot be credited safely; closing makes the server release every stream window.
      this.failConnection(new Error('Remote terminal stream received a malformed frame.'))
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (!stream) {
      if (
        frame.opcode === TerminalStreamOpcode.Output ||
        frame.opcode === TerminalStreamOpcode.OutputSpan
      ) {
        // Why: the renderer already disposed this stream; unsubscribe releases server credit that cannot reach a parser.
        this.sendFrame(frame.streamId, TerminalStreamOpcode.Unsubscribe)
      }
      return
    }
    if (
      (frame.opcode === TerminalStreamOpcode.Output ||
        frame.opcode === TerminalStreamOpcode.OutputSpan) &&
      shouldDropE2eRemoteTerminalOutput(stream, frame.payload.byteLength)
    ) {
      this.queueOutputAcknowledgement(stream, frame.payload.byteLength)
      return
    }
    stream.watchdog.recordInbound()
    if (frame.opcode === TerminalStreamOpcode.WriteUnavailable) {
      stream.callbacks.onWriteUnavailable?.()
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
        // Why: older servers replay snapshot-covered buffered chunks after a
        // requested recovery; rendering them would duplicate the recovered tail.
        if (
          typeof seq === 'number' &&
          typeof stream.recoverySnapshotSeq === 'number' &&
          seq <= stream.recoverySnapshotSeq
        ) {
          return
        }
        if (this.detectOutputGap(stream, seq, rawLength)) {
          this.requestResyncSnapshot(stream)
          return
        }
        if (typeof seq === 'number') {
          stream.expectedSeq = seq
          stream.commandProbeBaselineSeq = undefined
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
      try {
        const settleWatchdog = stream.watchdog.beginOutputDelivery(frame.payload.byteLength)
        deliverTerminalDataWithDeferredCredit(() => {
          settleWatchdog()
          if (shouldHoldE2eRemoteTerminalAck(stream.terminal)) {
            stream.heldAckBytes += frame.payload.byteLength
          } else {
            this.queueOutputAcknowledgement(stream, frame.payload.byteLength)
          }
        }, deliverOutput)
      } catch (error) {
        this.failConnection(
          error instanceof Error ? error : new Error('Remote terminal output delivery failed.')
        )
      }
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
      const snapshotApplied = !stream.snapshotOverflowed && info?.truncated !== true
      const matchesPendingRequest =
        target === 'request' &&
        pendingRequest &&
        (typeof info?.requestId === 'number'
          ? info.requestId === pendingRequest.requestId
          : stream.initialSnapshotReceived)
      if (snapshotApplied) {
        if (matchesPendingRequest) {
          pendingRequest.resolve({
            availability: classifySnapshotAvailability(stream.snapshotOverflowed, info),
            snapshot: {
              data: data ?? '',
              cols: info?.cols ?? 80,
              rows: info?.rows ?? 24,
              seq: info?.seq,
              source: info?.source,
              pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi
            }
          })
          clearPendingSnapshotRequest(stream)
        } else if (target === 'initial') {
          stream.callbacks.onSnapshot(data ?? '', {
            cols: info?.cols,
            rows: info?.rows,
            pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi
          })
        } else if (target === 'recovery') {
          // Why: a server-pushed recovery snapshot replaces terminal state
          // mid-session; clear the screen and scrollback before applying it.
          // An empty snapshot is still applied so stale dropped output does
          // not linger on a terminal the model says is blank.
          stream.callbacks.onSnapshot(`\x1b[2J\x1b[3J\x1b[H${data ?? ''}`, {
            cols: info?.cols,
            rows: info?.rows,
            pendingEscapeTailAnsi: info?.pendingEscapeTailAnsi
          })
        }
      } else if (matchesPendingRequest) {
        pendingRequest.resolve({
          availability: classifySnapshotAvailability(stream.snapshotOverflowed, info),
          snapshot: null
        })
        clearPendingSnapshotRequest(stream)
      }
      clearSnapshot(stream)
      if (target === 'initial') {
        clearResyncTimer(stream)
        stream.expectedSeq = typeof info?.seq === 'number' ? info.seq : undefined
        stream.commandProbeBaselineSeq = undefined
        stream.resyncInFlight = false
        stream.resyncPendingSend = false
        stream.initialSnapshotReceived = true
        stream.callbacks.onSubscribed?.()
      } else if (target === 'recovery') {
        // Why: only an applied recovery is authoritative; retaining the prior
        // high-water after a discarded snapshot keeps the gap detectable.
        if (snapshotApplied) {
          clearResyncTimer(stream)
          stream.expectedSeq = typeof info?.seq === 'number' ? info.seq : undefined
          stream.commandProbeBaselineSeq = undefined
          stream.recoverySnapshotSeq = typeof info?.seq === 'number' ? info.seq : undefined
          stream.resyncAttempts = 0
          stream.resyncInFlight = false
          stream.resyncPendingSend = false
        } else if (stream.resyncInFlight) {
          this.scheduleResyncRetry(stream)
        } else {
          // Why: a discarded server-pushed recovery leaves dropped output
          // unrepresented; pull a fresh snapshot now instead of waiting for
          // the next chunk to expose the gap.
          this.requestResyncSnapshot(stream)
        }
      } else {
        this.sendDeferredResyncSnapshot(stream)
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Error) {
      const message = decodeTerminalStreamText(frame.payload)
      if (message === TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR) {
        stream.capacityRejected = true
        return
      }
      clearSnapshot(stream)
      const pendingSnapshotRequest = stream.pendingSnapshotRequest
      if (pendingSnapshotRequest) {
        clearPendingSnapshotRequest(stream)
        pendingSnapshotRequest.reject(new Error(message))
        this.sendDeferredResyncSnapshot(stream)
        return
      }
      // Why: a failed resync must re-open the live path or output stalls forever.
      clearResyncTimer(stream)
      stream.resyncInFlight = false
      stream.resyncPendingSend = false
      stream.callbacks.onError?.(message)
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
    if (stream.pendingSnapshotRequest) {
      // Why: snapshot frame groups are not multiplexed; wait for the manual
      // snapshot to finish so its response cannot be mistaken for recovery.
      // Arm the watchdog now so a dispatch path that consumes the pending
      // request without re-dispatching cannot hold the gate shut forever.
      stream.resyncPendingSend = true
      this.startResyncTimer(stream)
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
    this.startResyncTimer(stream)
    const sent = this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.SnapshotRequest,
      encodeTerminalStreamJson({ scrollbackRows: undefined })
    )
    if (!sent) {
      // Transport is down; the reconnect path re-subscribes from scratch.
      clearResyncTimer(stream)
      stream.resyncInFlight = false
    }
  }

  // Why: keep the gate shut across the backoff — the post-gap tail is corrupt
  // either way — and heal even if the flood ends with no further output.
  private scheduleResyncRetry(stream: RemoteRuntimeMultiplexedTerminalState): void {
    stream.resyncAttempts += 1
    const delay = Math.min(
      REMOTE_TERMINAL_RESYNC_RETRY_MAX_MS,
      REMOTE_TERMINAL_RESYNC_RETRY_BASE_MS * 2 ** Math.min(stream.resyncAttempts - 1, 4)
    )
    clearResyncTimer(stream)
    const timer = setTimeout(() => {
      if (
        stream.resyncTimer !== timer ||
        this.streams.get(stream.streamId) !== stream ||
        !stream.resyncInFlight
      ) {
        return
      }
      stream.resyncTimer = null
      if (stream.pendingSnapshotRequest) {
        stream.resyncPendingSend = true
        this.startResyncTimer(stream)
        return
      }
      this.sendResyncSnapshot(stream)
    }, delay)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    stream.resyncTimer = timer
  }

  private startResyncTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
    clearResyncTimer(stream)
    const timer = setTimeout(() => {
      if (
        stream.resyncTimer !== timer ||
        this.streams.get(stream.streamId) !== stream ||
        !stream.resyncInFlight
      ) {
        return
      }
      stream.resyncTimer = null
      stream.resyncInFlight = false
      stream.resyncPendingSend = false
    }, REMOTE_TERMINAL_RESYNC_TIMEOUT_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    stream.resyncTimer = timer
  }

  private async requestSnapshot(
    stream: RemoteRuntimeMultiplexedTerminalState,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    source?: 'headless' | 'renderer'
  } | null> {
    const outcome = await this.requestSnapshotOutcome(stream, opts)
    // Why: the concurrent-request guard used to reject before the outcome existed; keep that contract for legacy callers.
    if (
      outcome.availability.kind === 'retry-worthy' &&
      outcome.availability.cause === 'request-already-in-flight'
    ) {
      throw new Error('Remote terminal snapshot already in flight.')
    }
    return outcome.snapshot
  }

  private requestSnapshotOutcome(
    stream: RemoteRuntimeMultiplexedTerminalState,
    opts?: { scrollbackRows?: number }
  ): Promise<RemoteRuntimeSnapshotOutcome> {
    if (this.streams.get(stream.streamId) !== stream) {
      return Promise.resolve(retryWorthySnapshotOutcome('stream-detached'))
    }
    if (!this.ready || !this.subscription) {
      return Promise.resolve(retryWorthySnapshotOutcome('connection-not-ready'))
    }
    // Recovery uses an untagged snapshot frame group; callers can retry after
    // it completes instead of racing another request onto the same frame lane.
    if (stream.resyncInFlight) {
      return Promise.resolve(retryWorthySnapshotOutcome('resync-in-flight'))
    }
    if (stream.pendingSnapshotRequest) {
      return Promise.resolve(retryWorthySnapshotOutcome('request-already-in-flight'))
    }
    const requestId = this.allocateSnapshotRequestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (stream.pendingSnapshotRequest?.timer === timer) {
          clearPendingSnapshotRequest(stream)
          reject(new Error('Remote terminal snapshot timed out.'))
          this.recoverStalledStream(stream)
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
        resolve(retryWorthySnapshotOutcome('request-frame-not-sent'))
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
    if (stream.acknowledgeOutputSourceRanges && stream.streamGeneration) {
      const ackedEndByte = stream.sourceAckedEndByte + bytes
      const sent = this.sendFrame(
        stream.streamId,
        TerminalStreamOpcode.Ack,
        encodeTerminalStreamJson({
          streamGeneration: stream.streamGeneration,
          ackedEndByte
        })
      )
      if (sent) {
        stream.sourceAckedEndByte = ackedEndByte
      }
      return sent
    }
    return this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.Ack,
      encodeTerminalStreamJson({ bytes })
    )
  }

  private sendInput(stream: RemoteRuntimeMultiplexedTerminalState, text: string): boolean {
    const sent = this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.Input,
      encodeTerminalStreamText(text)
    )
    if (sent && !stream.outputPaused) {
      stream.watchdog.recordCommandInput(text)
    }
    return sent
  }

  private setOutputPaused(stream: RemoteRuntimeMultiplexedTerminalState, paused: boolean): boolean {
    if (!stream.supportsOutputPause || this.streams.get(stream.streamId) !== stream) {
      return false
    }
    if (stream.outputPaused === paused) {
      return true
    }
    const sent = this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.SetOutputPaused,
      encodeTerminalStreamJson({ paused })
    )
    if (sent) {
      stream.outputPaused = paused
    }
    return sent
  }

  private probeCommandResponse(stream: RemoteRuntimeMultiplexedTerminalState): void {
    void this.requestSnapshot(stream).then(
      (snapshot) => {
        if (this.streams.get(stream.streamId) !== stream) {
          return
        }
        if (typeof snapshot?.seq === 'number' && typeof stream.expectedSeq !== 'number') {
          if (
            typeof stream.commandProbeBaselineSeq === 'number' &&
            snapshot.seq > stream.commandProbeBaselineSeq
          ) {
            recordRendererCrashBreadcrumb('remote_terminal_stream_stall_probe_baseline_advanced', {
              baselineSeq: stream.commandProbeBaselineSeq,
              environmentId: this.environmentId,
              snapshotSeq: snapshot.seq,
              streamId: stream.streamId,
              terminal: stream.terminal
            })
            this.recoverStalledStream(stream)
            return
          }
          stream.commandProbeBaselineSeq ??= snapshot.seq
        } else if (
          typeof snapshot?.seq === 'number' &&
          typeof stream.expectedSeq === 'number' &&
          snapshot.seq > stream.expectedSeq
        ) {
          recordRendererCrashBreadcrumb('remote_terminal_stream_stall_probe_detected_gap', {
            deliveredSeq: stream.expectedSeq,
            environmentId: this.environmentId,
            snapshotSeq: snapshot.seq,
            streamId: stream.streamId,
            terminal: stream.terminal
          })
          this.recoverStalledStream(stream)
          return
        }
        stream.watchdog.completeCommandResponseProbe()
        recordRendererCrashBreadcrumb('remote_terminal_stream_stall_probe_succeeded', {
          deliveredSeq: stream.expectedSeq ?? null,
          environmentId: this.environmentId,
          probeBaselineSeq: stream.commandProbeBaselineSeq ?? null,
          snapshotSeq: snapshot?.seq ?? null,
          streamId: stream.streamId,
          terminal: stream.terminal
        })
      },
      () => {
        // Snapshot timeout owns recovery; an explicit host error already proves liveness.
        if (this.streams.get(stream.streamId) === stream) {
          stream.watchdog.completeCommandResponseProbe()
        }
      }
    )
  }

  private recoverStalledStream(stream: RemoteRuntimeMultiplexedTerminalState): void {
    if (this.streams.get(stream.streamId) !== stream) {
      return
    }
    stream.watchdog.dispose()
    discardOutputAcknowledgements(stream)
    clearSnapshot(stream)
    clearResyncTimer(stream)
    rejectPendingSnapshotRequest(stream, 'Remote terminal stream stopped responding.')
    this.streams.delete(stream.streamId)
    this.sendFrame(stream.streamId, TerminalStreamOpcode.Unsubscribe)
    if (stream.callbacks.onTransportClose) {
      stream.callbacks.onTransportClose({ recoverable: true })
    } else {
      stream.callbacks.onError?.('Remote terminal stream stopped responding.')
    }
    this.closeIfIdle()
  }

  private queueOutputAcknowledgement(
    stream: RemoteRuntimeMultiplexedTerminalState,
    bytes: number
  ): boolean {
    if (this.streams.get(stream.streamId) !== stream) {
      return true
    }
    stream.pendingAckBytes += bytes
    if (stream.pendingAckBytes >= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES) {
      return this.flushOutputAcknowledgement(stream)
    }
    if (stream.ackFlushTimer === null) {
      stream.ackFlushTimer = setTimeout(() => {
        stream.ackFlushTimer = null
        this.flushOutputAcknowledgement(stream)
      }, TERMINAL_MULTIPLEX_ACK_FLUSH_MS)
    }
    return true
  }

  private flushOutputAcknowledgement(stream: RemoteRuntimeMultiplexedTerminalState): boolean {
    clearAckFlushTimer(stream)
    const bytes = stream.pendingAckBytes
    stream.pendingAckBytes = 0
    return bytes <= 0 || this.acknowledgeOutput(stream, bytes)
  }

  getStreamsForE2e(): Iterable<RemoteRuntimeMultiplexedTerminalState> {
    return this.streams.values()
  }

  forceErrorForE2e(terminals: ReadonlySet<string>, message: string): number {
    let dispatched = 0
    for (const stream of this.streams.values()) {
      if (terminals.has(stream.terminal)) {
        stream.callbacks.onError?.(message)
        dispatched += 1
      }
    }
    return dispatched
  }

  releaseHeldAcksForE2e(): number {
    let released = 0
    for (const stream of this.streams.values()) {
      if (stream.heldAckBytes <= 0) {
        continue
      }
      const bytes = stream.heldAckBytes
      stream.heldAckBytes = 0
      if (this.queueOutputAcknowledgement(stream, bytes)) {
        released += bytes
      }
    }
    return released
  }

  sendInputForE2e(terminal: string, text: string): number {
    let sent = 0
    for (const stream of this.streams.values()) {
      if (stream.terminal === terminal && this.sendInput(stream, text)) {
        sent += 1
      }
    }
    return sent
  }

  private sendFrame(
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ): boolean {
    if (!this.matchesCurrentEnvironmentRevision() || !this.ready || !this.subscription) {
      return false
    }
    try {
      this.subscription.sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: 0, payload }))
      return true
    } catch (error) {
      this.handleClose(
        error instanceof Error ? error.message : 'Remote terminal transport write failed.'
      )
      return false
    }
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
      discardOutputAcknowledgements(stream)
      stream.watchdog.dispose()
      clearSnapshot(stream)
      clearResyncTimer(stream)
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
  if (multiplexer && !multiplexer.matchesCurrentEnvironmentRevision()) {
    multiplexer.closeForEnvironmentReplacement()
    multiplexer = undefined
  }
  if (!multiplexer) {
    multiplexer = new RemoteRuntimeTerminalMultiplexer(
      environmentId,
      getRuntimeEnvironmentRevision(environmentId),
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
  resetE2eDroppedRemoteOutput()
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

function clearAckFlushTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
  if (stream.ackFlushTimer !== null) {
    clearTimeout(stream.ackFlushTimer)
    stream.ackFlushTimer = null
  }
}

function discardOutputAcknowledgements(stream: RemoteRuntimeMultiplexedTerminalState): void {
  clearAckFlushTimer(stream)
  stream.pendingAckBytes = 0
  stream.heldAckBytes = 0
}

function clearPendingSnapshotRequest(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const request = stream.pendingSnapshotRequest
  stream.pendingSnapshotRequest = null
  if (request) {
    clearTimeout(request.timer)
  }
}

function clearResyncTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const timer = stream.resyncTimer
  stream.resyncTimer = null
  if (timer) {
    clearTimeout(timer)
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
    unavailable?: unknown
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
    unavailable: parseTerminalSnapshotUnavailableReason(raw.unavailable),
    pendingEscapeTailAnsi:
      typeof raw.pendingEscapeTailAnsi === 'string' ? raw.pendingEscapeTailAnsi : undefined
  }
}

function retryWorthySnapshotOutcome(
  cause: RemoteRuntimeSnapshotRetryCause
): RemoteRuntimeSnapshotOutcome {
  return { availability: { kind: 'retry-worthy', cause }, snapshot: null }
}

function classifySnapshotAvailability(
  clientOverflowed: boolean,
  info: RemoteRuntimeSnapshotInfo | null
): RemoteRuntimeSnapshotAvailability {
  if (clientOverflowed) {
    return { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' }
  }
  if (info?.unavailable === 'pending-output-overflowed') {
    return { kind: 'retry-worthy', cause: 'host-pending-output-overflowed' }
  }
  if (info?.unavailable === 'no-serializable-buffer') {
    return { kind: 'retry-worthy', cause: 'host-no-serializable-buffer' }
  }
  // Why: a truncated reply with no stated reason can only come from a host that predates `unavailable`.
  if (info?.truncated === true) {
    return { kind: 'unknown-legacy-host' }
  }
  return { kind: 'snapshot' }
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
