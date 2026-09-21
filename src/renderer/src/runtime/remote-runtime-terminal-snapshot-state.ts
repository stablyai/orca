import { decodeTerminalStreamJson } from '../../../shared/terminal-stream-protocol'
import { parseTerminalSnapshotUnavailableReason } from '../../../shared/terminal-snapshot-unavailability'
import { parseTerminalKittyKeyboardFlags } from '../../../shared/terminal-kitty-keyboard-flags'
import type {
  RemoteRuntimeMultiplexedTerminalState,
  RemoteRuntimeSnapshotAvailability,
  RemoteRuntimeSnapshotInfo,
  RemoteRuntimeSnapshotOutcome,
  RemoteRuntimeSnapshotRetryCause
} from './remote-runtime-terminal-multiplexer-types'

export const CONTROL_STREAM_ID = 0
export const MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000
export const REMOTE_TERMINAL_RESYNC_TIMEOUT_MS = 10_000
// Why: a truncated recovery means the server is too flooded to serialize;
// retrying once per incoming chunk would stampede it, so back off instead.
export const REMOTE_TERMINAL_RESYNC_RETRY_BASE_MS = 500
export const REMOTE_TERMINAL_RESYNC_RETRY_MAX_MS = 5_000
// Why: exported so the transport can classify it as benign — the snapshot was
// skipped but live output continues, so it must not surface a fatal red banner.
export const REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE =
  'Remote terminal snapshot exceeded the 2 MiB replay limit; live output will continue.'

export function concatBytes(chunks: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function clearSnapshot(stream: RemoteRuntimeMultiplexedTerminalState): void {
  stream.snapshotChunks = []
  stream.snapshotBytes = 0
  stream.snapshotOverflowed = false
  stream.snapshotTarget = 'initial'
  stream.snapshotInfo = null
}

export function clearAckFlushTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
  if (stream.ackFlushTimer !== null) {
    clearTimeout(stream.ackFlushTimer)
    stream.ackFlushTimer = null
  }
}

export function discardOutputAcknowledgements(stream: RemoteRuntimeMultiplexedTerminalState): void {
  clearAckFlushTimer(stream)
  stream.pendingAckBytes = 0
  stream.heldAckBytes = 0
}

export function clearPendingSnapshotRequest(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const request = stream.pendingSnapshotRequest
  stream.pendingSnapshotRequest = null
  if (request) {
    clearTimeout(request.timer)
  }
}

export function clearResyncTimer(stream: RemoteRuntimeMultiplexedTerminalState): void {
  const timer = stream.resyncTimer
  stream.resyncTimer = null
  if (timer) {
    clearTimeout(timer)
  }
}

export function rejectPendingSnapshotRequest(
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

export function decodeSnapshotInfo(
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
    kittyKeyboardFlags?: unknown
    alternateScreen?: unknown
    terminalOwner?: unknown
  }>(payload)
  if (!raw) {
    return null
  }
  return {
    cols: typeof raw.cols === 'number' ? raw.cols : undefined,
    rows: typeof raw.rows === 'number' ? raw.rows : undefined,
    seq: typeof raw.seq === 'number' ? raw.seq : undefined,
    source: raw.source === 'headless' || raw.source === 'renderer' ? raw.source : undefined,
    // Negative, fractional, and unsafe values are treated as absent, never clamped.
    kittyKeyboardFlags: parseTerminalKittyKeyboardFlags(raw.kittyKeyboardFlags),
    alternateScreen:
      raw.terminalOwner === 'shell' && typeof raw.alternateScreen === 'boolean'
        ? raw.alternateScreen
        : undefined,
    terminalOwner: raw.terminalOwner === 'shell' ? raw.terminalOwner : undefined,
    requestId: typeof raw.requestId === 'number' ? raw.requestId : undefined,
    truncated: raw.truncated === true,
    unavailable: parseTerminalSnapshotUnavailableReason(raw.unavailable),
    pendingEscapeTailAnsi:
      typeof raw.pendingEscapeTailAnsi === 'string' ? raw.pendingEscapeTailAnsi : undefined
  }
}

export function retryWorthySnapshotOutcome(
  cause: RemoteRuntimeSnapshotRetryCause
): RemoteRuntimeSnapshotOutcome {
  return { availability: { kind: 'retry-worthy', cause }, snapshot: null }
}

export function classifySnapshotAvailability(
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

export function isTerminalDriverState(
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
