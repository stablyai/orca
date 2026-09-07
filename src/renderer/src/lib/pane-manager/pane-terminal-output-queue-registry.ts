import {
  discardForegroundRenderSettle,
  type ForegroundTerminalOutputTarget
} from './pane-terminal-foreground-render-settle'
import { discardInFlightTerminalOutputAckCredits } from './pane-terminal-output-ack-credit'
import { cancelTerminalWriteStallWatch } from './terminal-write-pipeline-health'
import {
  TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS,
  terminalOutputBacklogCapChars
} from '../../../../shared/terminal-scrollback-policy'
import {
  exposeTerminalOutputSchedulerDebugApi as exposeDebugApi,
  recordTerminalOutputQueueDebugPressure as recordQueueDebugPressure,
  setTerminalOutputDebugQueueReader,
  terminalOutputSchedulerDebugEnabled as debugEnabled,
  terminalOutputSchedulerDebugState as debugState
} from './pane-terminal-output-scheduler-debug'

export type TerminalOutputTarget = ForegroundTerminalOutputTarget

export type TerminalOutputBeforeWrite = (data: string) => void
type TerminalBacklogRecoveryRequest = () => boolean
export type TerminalOutputParsedCallback = () => void
type ForegroundRefreshSyncResolver = () => boolean

export type WriteTerminalOutputOptions = {
  foreground: boolean
  beforeWrite?: TerminalOutputBeforeWrite
  onParsed?: TerminalOutputParsedCallback
  /** Parse-deferred delivery ACK (terminal-pty-ack-gate). MUST be invoked when the chunk is parsed OR discarded by any drop path; fire-once, so double invocation is safe but omission permanently shrinks main's in-flight window. */
  ackCredit?: () => void
  onBackgroundBacklogDropped?: () => void
  latencySensitive?: boolean
  forceForegroundRefresh?: boolean
  followupForegroundRefresh?: boolean
  shouldRefreshForegroundSynchronously?: ForegroundRefreshSyncResolver
  stripTransientCursorShows?: boolean
  coalesceForeground?: boolean
  holdForeground?: boolean
}

type QueueChunk = {
  data: string
  // Tracks the backing data still reachable through this queue slot.
  retainedChars: number
  foreground: boolean
  forceForegroundRefresh: boolean
  followupForegroundRefresh: boolean
  shouldRefreshForegroundSynchronously: ForegroundRefreshSyncResolver
  stripTransientCursorShows: boolean
  beforeWrite?: TerminalOutputBeforeWrite
  onParsed?: TerminalOutputParsedCallback
  ackCredit?: () => void
}

export type QueuedWrite = {
  data: string
  foreground: boolean
  forceForegroundRefresh: boolean
  followupForegroundRefresh: boolean
  shouldRefreshForegroundSynchronously: ForegroundRefreshSyncResolver
  stripTransientCursorShows: boolean
  beforeWrite?: TerminalOutputBeforeWrite
  onParsed?: TerminalOutputParsedCallback
  ackCredits: (() => void)[]
}

export type QueueEntry = {
  terminal: TerminalOutputTarget
  chunks: QueueChunk[]
  chunkIndex: number
  queuedChars: number
  onBackgroundBacklogDropped?: () => void
  backgroundBacklogDropped: boolean
  highPriority: boolean
  foregroundHold: boolean
  foregroundHoldSafetyDelayMs: number
  foregroundCoalesce: boolean
  foregroundCoalesceDelayMs: number
  foregroundHoldSafetyTimer: ReturnType<typeof setTimeout> | null
  foregroundCoalesceTimer: ReturnType<typeof setTimeout> | null
  // Why: hold and coalesce cancel each other's fallback timer, so an alternating DEC 2026 stream could re-arm both forever and freeze a visible pane (#8754). This caps one non-drainable episode.
  foregroundReleaseDeadlineAt: number | null
  // Why: an open frame's own hold chunks may still push the deadline out, but once coalesce has taken the entry over the deadline stops moving so the two mechanisms can't re-arm each other.
  foregroundReleaseDeadlineFixed: boolean
}

export const BACKGROUND_FLUSH_DELAY_MS = 50
export const BACKGROUND_DRAIN_INTERVAL_MS = 16
export const HIGH_PRIORITY_DRAIN_INTERVAL_MS = 4
export const BACKGROUND_CHUNK_CHARS = 16 * 1024
export const MAX_WRITES_PER_DRAIN = 2
// Why 8: per-tick volume (8 x 16KB = 128KB ≈ 1.3ms parse) sets the sustained ceiling (~30MB/s) within DRAIN_TIME_BUDGET_MS; at 2 it was only 8MB/s against a ~100MB/s parser (see throughput bench).
export const HIGH_PRIORITY_MAX_WRITES_PER_DRAIN = 8
export const DRAIN_TIME_BUDGET_MS = 8
export const LARGE_BACKLOG_CHARS = 512 * 1024
// Why mutable: the cap scales with the user's scrollback setting (terminalOutputBacklogCapChars), configured when settings apply; the chunk-count cap stays fixed.
let maxQueueChars = TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS
export const MAX_BACKGROUND_QUEUE_CHUNKS = 4096

export function configureTerminalOutputBacklogCap(scrollbackRows: unknown): void {
  maxQueueChars = terminalOutputBacklogCapChars(scrollbackRows)
}

export function getTerminalOutputMaxQueueChars(): number {
  return maxQueueChars
}
// Why: leading CAN aborts any partial escape sequence before the style reset so the backlog warning renders cleanly.
export const BACKGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped hidden terminal output because the backlog grew too large.]\r\n'
// Why a separate foreground message: a visible pane hitting the cap means the drain couldn't keep up with a flood (starved renderer), not merely output produced while hidden.
export const FOREGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped a burst of terminal output because the backlog grew too large.]\r\n'
export const ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY = (): boolean => true

export const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()
setTerminalOutputDebugQueueReader(() => queuedByTerminal.values())
const backlogRecoveryByTerminal = new WeakMap<
  TerminalOutputTarget,
  TerminalBacklogRecoveryRequest
>()
let drainTimer: ReturnType<typeof setTimeout> | null = null
let drainTimerDelayMs: number | null = null
// Why a MessageChannel for zero-delay drains: Chromium clamps nested setTimeout(0) to ~4ms; a posted macrotask isn't clamped yet still yields to input/paint. Cancellation is by generation.
let drainImmediatePending = false
let drainImmediateGeneration = 0
let useMessageChannelDrain = typeof MessageChannel !== 'undefined' && !isVitestEnv()
let drainChannel: MessageChannel | null = null
// Why indirect: the drain loop lives downstream of this module, so it registers itself here rather than being imported back into the queue state it operates on.
let runDrain: (() => void) | null = null

export function setTerminalOutputDrainRunner(runner: () => void): void {
  runDrain = runner
}

function runDrainTick(): void {
  runDrain?.()
}

function isVitestEnv(): boolean {
  // Why: vitest fake timers can't advance MessageChannel macrotasks; the timer path keeps the suites' virtual clock authoritative.
  return typeof process !== 'undefined' && process.env?.VITEST === 'true'
}

function getDrainChannel(): MessageChannel {
  if (drainChannel === null) {
    drainChannel = new MessageChannel()
    drainChannel.port1.onmessage = (event: MessageEvent) => {
      if (event.data !== drainImmediateGeneration || !drainImmediatePending) {
        return
      }
      drainImmediatePending = false
      runDrainTick()
    }
  }
  return drainChannel
}

function cancelImmediateDrain(): void {
  drainImmediateGeneration++
  drainImmediatePending = false
}

export function setUseMessageChannelDrainForTesting(value: boolean | null): void {
  cancelImmediateDrain()
  useMessageChannelDrain = value ?? (typeof MessageChannel !== 'undefined' && !isVitestEnv())
}

export function isMessageChannelDrainEnabled(): boolean {
  return useMessageChannelDrain
}

export function markTerminalOutputDrainStarted(): void {
  drainTimer = null
  drainTimerDelayMs = null
}

export function scheduleDrain(delayMs: number): void {
  if (drainImmediatePending) {
    // An immediate drain is already armed — nothing can beat zero delay.
    return
  }
  if (drainTimer !== null) {
    if (drainTimerDelayMs !== null && drainTimerDelayMs <= delayMs) {
      return
    }
    clearTimeout(drainTimer)
    drainTimer = null
    drainTimerDelayMs = null
  }
  if (queuedByTerminal.size === 0) {
    return
  }
  if (debugEnabled) {
    debugState.scheduledDrainCount++
  }
  if (delayMs === 0 && useMessageChannelDrain) {
    drainImmediatePending = true
    getDrainChannel().port2.postMessage(drainImmediateGeneration)
    return
  }
  drainTimer = setTimeout(runDrainTick, delayMs)
  drainTimerDelayMs = delayMs
}

// Why: every discard path MUST fire these before clearing/replacing the queue — a dropped chunk still counts as consumed, or main's in-flight window shrinks permanently and the PTY wedges.
export function fireQueuedAckCredits(entry: QueueEntry): void {
  for (let index = entry.chunkIndex; index < entry.chunks.length; index += 1) {
    entry.chunks[index].ackCredit?.()
  }
}

export function requestRegisteredTerminalBacklogRecovery(terminal: TerminalOutputTarget): boolean {
  const requestRecovery = backlogRecoveryByTerminal.get(terminal)
  if (!requestRecovery) {
    return false
  }
  return requestRecovery()
}

export function registerTerminalBacklogRecovery(
  terminal: TerminalOutputTarget,
  requestRecovery: TerminalBacklogRecoveryRequest
): () => void {
  backlogRecoveryByTerminal.set(terminal, requestRecovery)
  return () => {
    if (backlogRecoveryByTerminal.get(terminal) === requestRecovery) {
      backlogRecoveryByTerminal.delete(terminal)
    }
  }
}

export function discardTerminalOutput(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  const entry = queuedByTerminal.get(terminal)
  if (entry) {
    // Why: discarded chunks still consumed their deliveries — credit them or main's in-flight window leaks (fireQueuedAckCredits).
    fireQueuedAckCredits(entry)
  }
  discardInFlightTerminalOutputAckCredits(terminal)
  queuedByTerminal.delete(terminal)
  discardForegroundRenderSettle(terminal)
  // Why: cancel the watch without masquerading as parse progress; replay guards use real completions to tell slow from wedged.
  cancelTerminalWriteStallWatch(terminal)
  recordQueueDebugPressure()
}
