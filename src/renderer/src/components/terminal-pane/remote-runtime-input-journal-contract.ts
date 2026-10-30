import type { PtyInputSource } from './pty-input-source'
import type { TerminalInputAckKind } from '../../../../shared/terminal-stream-protocol'
import type { RemoteRuntimeMultiplexedTerminal } from '../../runtime/remote-runtime-terminal-multiplexer-types'
import type { RemoteRuntimeInputEndpoint } from './remote-runtime-recovery-input-hold'

// Bound retained outage input; dropping its prefix also forbids replaying later command suffixes.
export const REMOTE_RUNTIME_INPUT_JOURNAL_MAX_CODE_UNITS = 1024 * 1024

// Back off host refusals because each retry costs a round trip while the PTY is unwritable.
export const REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS: readonly number[] = [
  100, 250, 500, 1000, 2000, 4000, 8000
]
// Resend stalled ACKs safely because the host deduplicates by sequence.
export const REMOTE_RUNTIME_INPUT_ACK_STALL_MS = 5000
// Persistent unwritable/stale handles need remount after the bounded refusal ladder.
export const REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION =
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS.length + 1

export type RemoteRuntimeInputStream = Pick<
  RemoteRuntimeMultiplexedTerminal,
  'sendInput' | 'inputLedgerId'
>

export type RemoteRuntimeInputSegment = {
  text: string
  queryReply: boolean
  source?: PtyInputSource
}

/** Replay unacked input in order from cumulative host ACKs across stream replacement/stalls; withdrawn, stale-reply or over-budget slots resend empty so later sequence numbers can advance. */
export type RemoteRuntimeInputJournal = {
  readonly sessionId: string
  /** Assigns the next sequences to `segments` and sends them, after any input `stream` still owes. */
  send: (
    stream: RemoteRuntimeInputStream,
    endpoint: RemoteRuntimeInputEndpoint,
    segments: readonly RemoteRuntimeInputSegment[]
  ) => number[]
  /** Resends unacked input once on a stream it has not used yet (a replacement after an outage). */
  resume: (stream: RemoteRuntimeInputStream, endpoint: RemoteRuntimeInputEndpoint) => void
  acknowledge: (appliedSeq: number, kind: TerminalInputAckKind) => void
  /** True once the host applies `seq`; false if it is withdrawn, dropped, or of unknown delivery. */
  whenAcknowledged: (seq: number) => Promise<boolean>
  /** Withdraws `seq` for its caller; a resend fills its slot with nothing. */
  cancel: (seq: number) => void
  /** True while input the host has not applied is still held for a resend. */
  hasUnacknowledgedInput: () => boolean
  discard: () => void
  discardUnscoped: () => void
}
