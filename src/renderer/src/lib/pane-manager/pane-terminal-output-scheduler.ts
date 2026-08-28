/* oxlint-disable max-lines -- Why: output ordering, foreground settle, queue state, and e2e diagnostics form one state machine; splitting it would make backlog/resume guarantees harder to audit. */
import {
  discardForegroundRenderSettle,
  writeForegroundTerminalChunk,
  type ForegroundTerminalOutputTarget
} from './pane-terminal-foreground-render-settle'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  discardInFlightTerminalOutputAckCredits,
  registerTerminalOutputAckCredits
} from './pane-terminal-output-ack-credit'
import {
  armTerminalWriteStallWatch,
  cancelTerminalWriteStallWatch,
  failTerminalWriteStallWatch,
  isTerminalWritePipelineCertifiedDead,
  recordTerminalParseProgress,
  settleTerminalWriteStallWatch
} from './terminal-write-pipeline-health'
import {
  TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS,
  terminalOutputBacklogCapChars
} from '../../../../shared/terminal-scrollback-policy'
import {
  coalescedQueuedDataNeedsCursorRestore,
  containsDrainableCursorRestore,
  removeTransientCursorShowSequences,
  SYNC_FOREGROUND_FLUSH_CHARS
} from './pane-terminal-cursor-sequencing'
import {
  exposeTerminalOutputSchedulerDebugApi as exposeDebugApi,
  recordTerminalOutputQueueDebugPressure as recordQueueDebugPressure,
  setTerminalOutputDebugQueueReader,
  terminalOutputSchedulerDebugEnabled as debugEnabled,
  terminalOutputSchedulerDebugState as debugState
} from './pane-terminal-output-scheduler-debug'
import { enqueueChunk, takeQueuedChunk } from './pane-terminal-output-queue-chunks'

type TerminalOutputTarget = ForegroundTerminalOutputTarget

export type TerminalOutputBeforeWrite = (data: string) => void
type TerminalBacklogRecoveryRequest = () => boolean
export type TerminalOutputParsedCallback = () => void
type ForegroundRefreshSyncResolver = () => boolean

type WriteTerminalOutputOptions = {
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

const BACKGROUND_FLUSH_DELAY_MS = 50
const BACKGROUND_DRAIN_INTERVAL_MS = 16
const HIGH_PRIORITY_DRAIN_INTERVAL_MS = 4
const BACKGROUND_CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_DRAIN = 2
// Why 8: per-tick volume (8 x 16KB = 128KB ≈ 1.3ms parse) sets the sustained ceiling (~30MB/s) within DRAIN_TIME_BUDGET_MS; at 2 it was only 8MB/s against a ~100MB/s parser (see throughput bench).
const HIGH_PRIORITY_MAX_WRITES_PER_DRAIN = 8
const DRAIN_TIME_BUDGET_MS = 8
const LARGE_BACKLOG_CHARS = 512 * 1024
// Why mutable: the cap scales with the user's scrollback setting (terminalOutputBacklogCapChars), configured when settings apply; the chunk-count cap stays fixed.
let maxQueueChars = TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS
const MAX_BACKGROUND_QUEUE_CHUNKS = 4096

export function configureTerminalOutputBacklogCap(scrollbackRows: unknown): void {
  maxQueueChars = terminalOutputBacklogCapChars(scrollbackRows)
}
const PARSE_SETTLE_TIMEOUT_MS = 250
const FOREGROUND_COALESCE_DELAY_MS = 1000
const FOREGROUND_HOLD_SAFETY_DELAY_MS = 250
// Why: key repeat can tick every 30-50ms; one frame catches split restores without batching multiple typed-character redraws behind the fallback.
const LATENCY_SENSITIVE_FOREGROUND_COALESCE_DELAY_MS = 16
const LATENCY_SENSITIVE_FOREGROUND_HOLD_SAFETY_DELAY_MS = 32
// Why: leading CAN aborts any partial escape sequence before the style reset so the backlog warning renders cleanly.
const BACKGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped hidden terminal output because the backlog grew too large.]\r\n'
// Why a separate foreground message: a visible pane hitting the cap means the drain couldn't keep up with a flood (starved renderer), not merely output produced while hidden.
const FOREGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped a burst of terminal output because the backlog grew too large.]\r\n'
const ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY = (): boolean => true

const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()
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
      drainQueuedOutput()
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

function scheduleDrain(delayMs: number): void {
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
  drainTimer = setTimeout(drainQueuedOutput, delayMs)
  drainTimerDelayMs = delayMs
}

function createQueueEntry(
  terminal: TerminalOutputTarget,
  options: WriteTerminalOutputOptions
): QueueEntry {
  return {
    terminal,
    chunks: [],
    chunkIndex: 0,
    queuedChars: 0,
    onBackgroundBacklogDropped: options.onBackgroundBacklogDropped,
    backgroundBacklogDropped: false,
    highPriority: true,
    foregroundHold: false,
    foregroundHoldSafetyDelayMs: FOREGROUND_HOLD_SAFETY_DELAY_MS,
    foregroundCoalesce: false,
    foregroundCoalesceDelayMs: FOREGROUND_COALESCE_DELAY_MS,
    foregroundHoldSafetyTimer: null,
    foregroundCoalesceTimer: null,
    foregroundReleaseDeadlineAt: null,
    foregroundReleaseDeadlineFixed: false
  }
}

// Returns the delay the caller's timer must use so it never outlives the episode deadline.
function armForegroundReleaseDeadline(
  entry: QueueEntry,
  delayMs: number,
  mayExtend: boolean
): number {
  const now = getDrainNow()
  const requested = now + delayMs
  entry.foregroundReleaseDeadlineAt =
    entry.foregroundReleaseDeadlineAt === null ||
    (mayExtend && !entry.foregroundReleaseDeadlineFixed)
      ? requested
      : Math.min(entry.foregroundReleaseDeadlineAt, requested)
  return Math.max(0, entry.foregroundReleaseDeadlineAt - now)
}

// Why: reopen the gate only once the entry is drainable again, so the next synchronized frame gets a full budget.
function resetForegroundReleaseGate(entry: QueueEntry): void {
  entry.foregroundReleaseDeadlineAt = null
  entry.foregroundReleaseDeadlineFixed = false
}

function clearForegroundRelease(entry: QueueEntry): void {
  clearForegroundHoldSafety(entry)
  clearForegroundCoalesce(entry)
  resetForegroundReleaseGate(entry)
}

function clearForegroundHoldSafety(entry: QueueEntry): void {
  if (entry.foregroundHoldSafetyTimer === null) {
    return
  }
  clearTimeout(entry.foregroundHoldSafetyTimer)
  entry.foregroundHoldSafetyTimer = null
  entry.foregroundHoldSafetyDelayMs = FOREGROUND_HOLD_SAFETY_DELAY_MS
}

function clearForegroundCoalesce(entry: QueueEntry): void {
  if (entry.foregroundCoalesceTimer !== null) {
    clearTimeout(entry.foregroundCoalesceTimer)
    entry.foregroundCoalesceTimer = null
  }
  entry.foregroundCoalesce = false
  entry.foregroundCoalesceDelayMs = FOREGROUND_COALESCE_DELAY_MS
}

function scheduleForegroundHoldSafety(entry: QueueEntry): void {
  clearForegroundHoldSafety(entry)
  const delayMs = armForegroundReleaseDeadline(entry, entry.foregroundHoldSafetyDelayMs, true)
  entry.foregroundHoldSafetyTimer = setTimeout(() => {
    entry.foregroundHoldSafetyTimer = null
    entry.foregroundHold = false
    clearForegroundCoalesce(entry)
    resetForegroundReleaseGate(entry)
    if (queuedByTerminal.has(entry.terminal)) {
      scheduleDrain(0)
    }
  }, delayMs)
}

function scheduleForegroundCoalesceRelease(
  entry: QueueEntry,
  options?: { rescheduleEarlier?: boolean }
): void {
  if (entry.foregroundCoalesceTimer !== null) {
    if (options?.rescheduleEarlier !== true) {
      entry.foregroundCoalesce = true
      return
    }
    clearTimeout(entry.foregroundCoalesceTimer)
    entry.foregroundCoalesceTimer = null
  }
  entry.foregroundCoalesce = true
  // Why fixed from here: a later hold chunk must clamp to this deadline instead of restarting the pair's mutual re-arm (#8754).
  entry.foregroundReleaseDeadlineFixed = true
  const delayMs = armForegroundReleaseDeadline(entry, entry.foregroundCoalesceDelayMs, false)
  entry.foregroundCoalesceTimer = setTimeout(() => {
    entry.foregroundCoalesceTimer = null
    entry.foregroundCoalesce = false
    resetForegroundReleaseGate(entry)
    if (queuedByTerminal.has(entry.terminal)) {
      scheduleDrain(0)
    }
  }, delayMs)
}

function isEntryDrainable(entry: QueueEntry): boolean {
  return !entry.foregroundHold && !entry.foregroundCoalesce
}

// Why: every discard path MUST fire these before clearing/replacing the queue — a dropped chunk still counts as consumed, or main's in-flight window shrinks permanently and the PTY wedges.
function fireQueuedAckCredits(entry: QueueEntry): void {
  for (let index = entry.chunkIndex; index < entry.chunks.length; index += 1) {
    entry.chunks[index].ackCredit?.()
  }
}

function discardDetachedQueueEntry(entry: QueueEntry): void {
  fireQueuedAckCredits(entry)
  entry.chunks.length = 0
  entry.chunkIndex = 0
  entry.queuedChars = 0
  entry.highPriority = false
  clearForegroundRelease(entry)
}

function queueCapExceeded(entry: QueueEntry): boolean {
  return (
    entry.queuedChars > maxQueueChars ||
    entry.chunks.length - entry.chunkIndex > MAX_BACKGROUND_QUEUE_CHUNKS
  )
}

function replaceBacklogWithWarning(
  entry: QueueEntry,
  warning: string = BACKGROUND_BACKLOG_WARNING
): void {
  const shouldNotify = !entry.backgroundBacklogDropped
  if (shouldNotify) {
    // Why: field visibility for cap tuning — drop frequency and size decide whether the cap is too small (issue #2836 / #7017).
    recordRendererCrashBreadcrumb('terminal_output_backlog_dropped', {
      foreground: warning === FOREGROUND_BACKLOG_WARNING,
      droppedChars: entry.queuedChars,
      capChars: maxQueueChars
    })
  }
  let beforeWrite: TerminalOutputBeforeWrite | undefined
  for (let index = entry.chunks.length - 1; index >= entry.chunkIndex; index--) {
    if (entry.chunks[index]?.beforeWrite) {
      beforeWrite = entry.chunks[index].beforeWrite
      break
    }
  }
  clearForegroundHoldSafety(entry)
  fireQueuedAckCredits(entry)
  entry.chunks = [
    {
      data: warning,
      retainedChars: warning.length,
      foreground: false,
      forceForegroundRefresh: false,
      followupForegroundRefresh: false,
      shouldRefreshForegroundSynchronously: ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY,
      stripTransientCursorShows: false,
      beforeWrite
    }
  ]
  entry.chunkIndex = 0
  entry.queuedChars = warning.length
  entry.backgroundBacklogDropped = true
  entry.highPriority = true
  entry.foregroundHold = false
  if (debugEnabled && shouldNotify) {
    debugState.droppedBacklogCount++
  }
  clearForegroundRelease(entry)
  recordQueueDebugPressure()
  if (shouldNotify) {
    entry.onBackgroundBacklogDropped?.()
  }
}

function hasQueuedChunks(entry: QueueEntry): boolean {
  return entry.chunkIndex < entry.chunks.length
}

function hasHighPriorityBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (
      isEntryDrainable(entry) &&
      (entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS)
    ) {
      return true
    }
  }
  return false
}

function hasDrainableBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (isEntryDrainable(entry)) {
      return true
    }
  }
  return false
}

// Why no per-write scroll enforcement: xterm's BufferService.isUserScrolling owns live follow/pin; app-side enforcement is limited to structural ops xterm can't identify, like replay.
function writeBackgroundTerminalChunk(
  terminal: TerminalOutputTarget,
  data: string,
  onParsed?: TerminalOutputParsedCallback,
  onWriteFailure?: () => void
): boolean {
  // Why guarded: these callbacks run inside xterm's WriteBuffer loop, where an escaping throw permanently wedges the terminal (see xterm-write-callback-guard.ts).
  const runOnParsed = onParsed
    ? (): void => runGuardedWriteCompletionStep('background-on-parsed', onParsed)
    : undefined
  const runOnWriteFailure = onWriteFailure
    ? (): void => runGuardedWriteCompletionStep('background-on-write-failure', onWriteFailure)
    : undefined
  try {
    if (!runOnParsed || terminal.write.length < 2) {
      terminal.write(data)
      runOnParsed?.()
      return true
    }
    terminal.write(data, runOnParsed)
    return true
  } catch {
    runOnWriteFailure?.()
    return false
  }
}

function takeNextDrainableEntry(): QueueEntry | null {
  let largeBacklogEntry: QueueEntry | null = null
  for (const entry of queuedByTerminal.values()) {
    if (!isEntryDrainable(entry)) {
      continue
    }
    // Why: active/foreground output should be chosen first, not left in insertion order behind older background terminals.
    if (entry.highPriority) {
      queuedByTerminal.delete(entry.terminal)
      return entry
    }
    if (!largeBacklogEntry && entry.queuedChars > LARGE_BACKLOG_CHARS) {
      largeBacklogEntry = entry
    }
  }
  if (largeBacklogEntry) {
    queuedByTerminal.delete(largeBacklogEntry.terminal)
    return largeBacklogEntry
  }
  for (const entry of queuedByTerminal.values()) {
    if (!isEntryDrainable(entry)) {
      continue
    }
    queuedByTerminal.delete(entry.terminal)
    return entry
  }
  return null
}

// Why: re-arm a zero-delay drain once xterm confirms the previous high-priority batch parsed; the fixed 4/16ms cadence otherwise drips far below xterm's ~100 MB/s parse. Only visible panes are pacer-clocked; background keeps the fixed cadence to protect the focused terminal.
function makeParseClockPacer(): () => void {
  return () => {
    try {
      if (queuedByTerminal.size > 0 && hasHighPriorityBacklog()) {
        scheduleDrain(0)
      }
    } catch {
      // Why: runs inside xterm's write-callback chain; a throw here would wedge the terminal (see xterm-write-callback-guard.ts).
    }
  }
}

function composeParsedCallback(
  terminal: TerminalOutputTarget,
  onParsed: TerminalOutputParsedCallback | undefined,
  ackCreditsParsed: (() => void) | undefined,
  pacer: (() => void) | undefined
): TerminalOutputParsedCallback {
  // Why always non-undefined: the callback doubles as the pipeline-health settle signal — with none, the stall watch could never settle, forcing a probe round-trip per healthy idle pane.
  return () => {
    try {
      onParsed?.()
    } finally {
      ackCreditsParsed?.()
      pacer?.()
      settleTerminalWriteStallWatch(terminal)
    }
  }
}

function composeWriteFailureCallback(
  terminal: TerminalOutputTarget,
  ackCreditsParsed: (() => void) | undefined
): () => void {
  return () => {
    try {
      // A rejected write still consumed the main-owned delivery window.
      ackCreditsParsed?.()
    } finally {
      // Why: a synchronous rejection proves undeliverability but nothing about parse progress; recover without extending replay guards.
      failTerminalWriteStallWatch(terminal)
    }
  }
}

function writeQueuedChunk(entry: QueueEntry): 'foreground' | 'background' | null {
  if (isTerminalWritePipelineCertifiedDead(entry.terminal)) {
    // The drain owns this detached entry, so map-based discard cannot see it.
    discardDetachedQueueEntry(entry)
    discardTerminalOutput(entry.terminal)
    return null
  }
  const queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  if (!queuedWrite) {
    return null
  }
  const pacer = entry.highPriority ? makeParseClockPacer() : undefined
  const ackCreditsParsed = registerTerminalOutputAckCredits(entry.terminal, queuedWrite.ackCredits)
  // Why armed BEFORE the write: a wedged WriteBuffer (issue #2836) or disposed xterm (6.1.0-beta.287) never runs the parsed callback, so the watch must be live first to catch it.
  armTerminalWriteStallWatch(entry.terminal, {
    onCertifiedDead: () => discardTerminalOutput(entry.terminal)
  })
  try {
    queuedWrite.beforeWrite?.(queuedWrite.data)
    const writeAccepted = queuedWrite.foreground
      ? writeForegroundTerminalChunk(
          entry.terminal,
          queuedWrite.stripTransientCursorShows
            ? removeTransientCursorShowSequences(queuedWrite.data)
            : queuedWrite.data,
          {
            forceViewportRefresh: queuedWrite.forceForegroundRefresh,
            followupViewportRefresh: queuedWrite.followupForegroundRefresh,
            shouldRefreshViewportSynchronously: queuedWrite.shouldRefreshForegroundSynchronously,
            onParsed: composeParsedCallback(
              entry.terminal,
              queuedWrite.onParsed,
              ackCreditsParsed,
              pacer
            ),
            onWriteFailure: composeWriteFailureCallback(entry.terminal, ackCreditsParsed)
          }
        )
      : writeBackgroundTerminalChunk(
          entry.terminal,
          queuedWrite.data,
          composeParsedCallback(entry.terminal, queuedWrite.onParsed, ackCreditsParsed, pacer),
          composeWriteFailureCallback(entry.terminal, ackCreditsParsed)
        )
    if (!writeAccepted) {
      // Why: the failure callback credited the submitted chunk; credit and abandon the detached tail so the drain can't retry a certified-dead xterm.
      fireQueuedAckCredits(entry)
      entry.chunks.length = 0
      entry.chunkIndex = 0
      entry.queuedChars = 0
      clearForegroundRelease(entry)
      recordQueueDebugPressure()
      return null
    }
  } catch {
    // Why: beforeWrite or write setup can fail before xterm owns the bytes; cancel the armed watch without claiming parser failure.
    cancelTerminalWriteStallWatch(entry.terminal)
    ackCreditsParsed?.()
    fireQueuedAckCredits(entry)
    entry.chunks.length = 0
    entry.chunkIndex = 0
    entry.queuedChars = 0
    clearForegroundRelease(entry)
    recordQueueDebugPressure()
    return null
  }
  return queuedWrite.foreground ? 'foreground' : 'background'
}

function getDrainNow(): number {
  if (typeof performance !== 'undefined') {
    return performance.now()
  }
  return Date.now()
}

function drainQueuedOutput(): void {
  drainTimer = null
  drainTimerDelayMs = null
  let writes = 0
  const startedAt = getDrainNow()
  const highPriority = hasHighPriorityBacklog()
  const maxWrites = highPriority ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN : MAX_WRITES_PER_DRAIN

  while (queuedByTerminal.size > 0 && writes < maxWrites) {
    const entry = takeNextDrainableEntry()
    if (!entry) {
      break
    }

    const writeKind = writeQueuedChunk(entry)
    if (writeKind) {
      writes++
      if (debugEnabled) {
        if (writeKind === 'foreground') {
          debugState.deferredForegroundWriteCount++
        } else {
          debugState.backgroundWriteCount++
        }
      }
    }
    if (hasQueuedChunks(entry)) {
      queuedByTerminal.set(entry.terminal, entry)
    } else {
      entry.highPriority = false
      clearForegroundRelease(entry)
    }
    // Why: xterm parsing and DOM work share the renderer thread with input; keep draining cooperative so WSL/agent output can't pin the UI.
    if (writes > 0 && getDrainNow() - startedAt >= DRAIN_TIME_BUDGET_MS) {
      break
    }
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes)
    debugState.drainHighPriority.push(highPriority)
  }
  recordQueueDebugPressure()
  if (queuedByTerminal.size > 0 && hasDrainableBacklog()) {
    // Why 0 on the channel path: a posted message already yields (input/paint serviced between macrotasks), so the 4ms interval only deepened the queue; timer path keeps it for fake-timer tests.
    scheduleDrain(
      hasHighPriorityBacklog()
        ? useMessageChannelDrain
          ? 0
          : HIGH_PRIORITY_DRAIN_INTERVAL_MS
        : BACKGROUND_DRAIN_INTERVAL_MS
    )
  }
}

export function writeTerminalOutput(
  terminal: TerminalOutputTarget,
  data: string,
  options: WriteTerminalOutputOptions
): void {
  exposeDebugApi()
  // Why: recovery may be budget-delayed while PTY output keeps flowing; main owns the authoritative buffer, so credit delivery without waking dead xterm.
  if (isTerminalWritePipelineCertifiedDead(terminal)) {
    options.ackCredit?.()
    return
  }
  if (!data) {
    // Why: an empty write still consumed its delivery — credit or main's in-flight window leaks.
    options.ackCredit?.()
    return
  }

  if (options.foreground) {
    const entry = queuedByTerminal.get(terminal)
    if (entry?.highPriority || options.coalesceForeground || options.holdForeground) {
      const queued = entry ?? createQueueEntry(terminal, options)
      queued.onBackgroundBacklogDropped = options.onBackgroundBacklogDropped
      queued.highPriority = true
      queuedByTerminal.set(terminal, queued)
      enqueueChunk(queued, data, {
        foreground: true,
        forceForegroundRefresh: options.forceForegroundRefresh,
        followupForegroundRefresh: options.followupForegroundRefresh,
        shouldRefreshForegroundSynchronously: options.shouldRefreshForegroundSynchronously,
        stripTransientCursorShows: options.stripTransientCursorShows,
        beforeWrite: options.beforeWrite,
        onParsed: options.onParsed,
        ackCredit: options.ackCredit
      })
      if (debugEnabled) {
        debugState.foregroundWriteCount++
        debugState.deferredForegroundEnqueueCount++
      }
      // Why: a visible pane's queue was previously uncapped — a flood the drain couldn't keep up with ballooned renderer memory without bound.
      if (queueCapExceeded(queued)) {
        replaceBacklogWithWarning(queued, FOREGROUND_BACKLOG_WARNING)
        scheduleDrain(0)
        return
      }
      if (options.holdForeground) {
        // Why: synchronized-output start/body chunks contain transient cursor moves; holding them prevents Chromium from rasterizing those states.
        if (options.latencySensitive === true) {
          // Why: Codex composer redraws can split the end marker from the input-triggered frame; keep cursor protection without a human-visible fallback delay on typed chars.
          queued.foregroundHoldSafetyDelayMs = Math.min(
            queued.foregroundHoldSafetyDelayMs,
            LATENCY_SENSITIVE_FOREGROUND_HOLD_SAFETY_DELAY_MS
          )
        } else if (!queued.foregroundHold) {
          queued.foregroundHoldSafetyDelayMs = FOREGROUND_HOLD_SAFETY_DELAY_MS
        }
        queued.foregroundHold = true
        clearForegroundCoalesce(queued)
        scheduleForegroundHoldSafety(queued)
        return
      }
      if (options.coalesceForeground || queued.foregroundCoalesce) {
        queued.foregroundHold = false
        clearForegroundHoldSafety(queued)
        const shouldShortenCoalesceForLatencySensitiveForeground = options.latencySensitive === true
        if (shouldShortenCoalesceForLatencySensitiveForeground) {
          // Why: user input echo must not inherit the normal synchronized-frame restore fallback; wait briefly for the restore, then paint.
          queued.foregroundCoalesceDelayMs = Math.min(
            queued.foregroundCoalesceDelayMs,
            LATENCY_SENSITIVE_FOREGROUND_COALESCE_DELAY_MS
          )
        }
        const shouldDrainForLatencySensitiveForeground =
          shouldShortenCoalesceForLatencySensitiveForeground &&
          !coalescedQueuedDataNeedsCursorRestore(queued)
        if (containsDrainableCursorRestore(data) || shouldDrainForLatencySensitiveForeground) {
          clearForegroundRelease(queued)
          scheduleDrain(0)
          return
        }
        // Why: the PTY transport can split TUI synchronized-output end markers from the cursor-restoring bytes; wait for the restore, with the timer as bounded fallback.
        scheduleForegroundCoalesceRelease(queued, {
          rescheduleEarlier: shouldShortenCoalesceForLatencySensitiveForeground
        })
        return
      }
      queued.foregroundHold = false
      clearForegroundRelease(queued)
      scheduleDrain(0)
      return
    }
    if (entry && entry.queuedChars > SYNC_FOREGROUND_FLUSH_CHARS) {
      entry.highPriority = true
      enqueueChunk(entry, data, {
        foreground: true,
        forceForegroundRefresh: options.forceForegroundRefresh,
        followupForegroundRefresh: options.followupForegroundRefresh,
        shouldRefreshForegroundSynchronously: options.shouldRefreshForegroundSynchronously,
        stripTransientCursorShows: options.stripTransientCursorShows,
        beforeWrite: options.beforeWrite,
        onParsed: options.onParsed,
        ackCredit: options.ackCredit
      })
      if (debugEnabled) {
        debugState.foregroundWriteCount++
        debugState.deferredForegroundEnqueueCount++
      }
      if (queueCapExceeded(entry)) {
        replaceBacklogWithWarning(entry, FOREGROUND_BACKLOG_WARNING)
      }
      // Why: returning from a hidden window can have megabytes queued — keep byte order but drain async so the first foreground frame isn't pinned behind the whole backlog.
      scheduleDrain(0)
      return
    }
    if (options.latencySensitive === false) {
      let queued = entry
      if (!queued) {
        queued = createQueueEntry(terminal, options)
        queuedByTerminal.set(terminal, queued)
      } else {
        queued.onBackgroundBacklogDropped = options.onBackgroundBacklogDropped
        queued.highPriority = true
      }
      enqueueChunk(queued, data, {
        foreground: true,
        forceForegroundRefresh: options.forceForegroundRefresh,
        followupForegroundRefresh: options.followupForegroundRefresh,
        shouldRefreshForegroundSynchronously: options.shouldRefreshForegroundSynchronously,
        stripTransientCursorShows: options.stripTransientCursorShows,
        beforeWrite: options.beforeWrite,
        onParsed: options.onParsed,
        ackCredit: options.ackCredit
      })
      if (debugEnabled) {
        debugState.foregroundWriteCount++
        debugState.deferredForegroundEnqueueCount++
      }
      if (queueCapExceeded(queued)) {
        replaceBacklogWithWarning(queued, FOREGROUND_BACKLOG_WARNING)
      }
      // Why: visible command floods are throughput work, not keystroke echo — queue behind a zero-delay drain so one IPC callback can't pin the renderer while input/paint wait.
      scheduleDrain(0)
      return
    }
    flushTerminalOutput(terminal)
    if (debugEnabled) {
      debugState.foregroundWriteCount++
    }
    const ackCreditsParsed = registerTerminalOutputAckCredits(
      terminal,
      options.ackCredit ? [options.ackCredit] : []
    )
    armTerminalWriteStallWatch(terminal, {
      onCertifiedDead: () => discardTerminalOutput(terminal)
    })
    try {
      options.beforeWrite?.(data)
      writeForegroundTerminalChunk(
        terminal,
        options.stripTransientCursorShows ? removeTransientCursorShowSequences(data) : data,
        {
          forceViewportRefresh: options.forceForegroundRefresh === true,
          followupViewportRefresh: options.followupForegroundRefresh === true,
          shouldRefreshViewportSynchronously:
            options.shouldRefreshForegroundSynchronously ?? ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY,
          onParsed: composeParsedCallback(terminal, options.onParsed, ackCreditsParsed, undefined),
          onWriteFailure: composeWriteFailureCallback(terminal, ackCreditsParsed)
        }
      )
    } catch (error) {
      // Why: beforeWrite can throw before xterm owns the callback, so consume the delivery here (xterm write throws are caught by the foreground writer).
      ackCreditsParsed?.()
      cancelTerminalWriteStallWatch(terminal)
      throw error
    }
    return
  }

  let entry = queuedByTerminal.get(terminal)
  if (!entry) {
    entry = createQueueEntry(terminal, options)
    entry.highPriority = false
    queuedByTerminal.set(terminal, entry)
  } else {
    entry.onBackgroundBacklogDropped = options.onBackgroundBacklogDropped
  }
  enqueueChunk(entry, data, {
    beforeWrite: options.beforeWrite,
    onParsed: options.onParsed,
    ackCredit: options.ackCredit
  })
  if (queueCapExceeded(entry)) {
    replaceBacklogWithWarning(entry)
  }
  if (debugEnabled) {
    debugState.backgroundEnqueueCount++
  }
  // Why: letting every non-focused pane call xterm.write immediately spawns a WriteBuffer timer per pane, starving the focused terminal on the shared renderer thread.
  scheduleDrain(
    entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS ? 0 : BACKGROUND_FLUSH_DELAY_MS
  )
}

export function flushTerminalOutput(
  terminal: TerminalOutputTarget,
  options?: { maxChars?: number }
): void {
  exposeDebugApi()
  const entry = queuedByTerminal.get(terminal)
  if (!entry) {
    return
  }
  queuedByTerminal.delete(terminal)
  if (isTerminalWritePipelineCertifiedDead(terminal)) {
    discardDetachedQueueEntry(entry)
    discardTerminalOutput(terminal)
    return
  }
  if (!isEntryDrainable(entry)) {
    queuedByTerminal.set(terminal, entry)
    return
  }
  if (entry.backgroundBacklogDropped && requestRegisteredTerminalBacklogRecovery(terminal)) {
    fireQueuedAckCredits(entry)
    entry.chunks.length = 0
    entry.chunkIndex = 0
    entry.queuedChars = 0
    entry.highPriority = false
    clearForegroundRelease(entry)
    recordQueueDebugPressure()
    return
  }

  let flushedChars = 0
  let queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  while (queuedWrite) {
    flushedChars += queuedWrite.data.length
    if (debugEnabled) {
      debugState.flushWriteCount++
    }
    const ackCreditsParsed = registerTerminalOutputAckCredits(terminal, queuedWrite.ackCredits)
    armTerminalWriteStallWatch(terminal, {
      onCertifiedDead: () => discardTerminalOutput(terminal)
    })
    try {
      queuedWrite.beforeWrite?.(queuedWrite.data)
      const writeAccepted = queuedWrite.foreground
        ? writeForegroundTerminalChunk(
            terminal,
            queuedWrite.stripTransientCursorShows
              ? removeTransientCursorShowSequences(queuedWrite.data)
              : queuedWrite.data,
            {
              forceViewportRefresh: queuedWrite.forceForegroundRefresh,
              followupViewportRefresh: queuedWrite.followupForegroundRefresh,
              shouldRefreshViewportSynchronously: queuedWrite.shouldRefreshForegroundSynchronously,
              onParsed: composeParsedCallback(
                terminal,
                queuedWrite.onParsed,
                ackCreditsParsed,
                undefined
              ),
              onWriteFailure: composeWriteFailureCallback(terminal, ackCreditsParsed)
            }
          )
        : writeBackgroundTerminalChunk(
            terminal,
            queuedWrite.data,
            composeParsedCallback(terminal, queuedWrite.onParsed, ackCreditsParsed, undefined),
            composeWriteFailureCallback(terminal, ackCreditsParsed)
          )
      if (!writeAccepted) {
        fireQueuedAckCredits(entry)
        clearForegroundRelease(entry)
        recordQueueDebugPressure()
        return
      }
    } catch {
      // Why: pre-write hooks/setup failed before xterm owned these bytes; cancel the watch, but consumed + abandoned chunks still credit delivery.
      cancelTerminalWriteStallWatch(terminal)
      ackCreditsParsed?.()
      fireQueuedAckCredits(entry)
      clearForegroundRelease(entry)
      recordQueueDebugPressure()
      return
    }
    if (options?.maxChars !== undefined && flushedChars >= options.maxChars) {
      break
    }
    queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  }
  if (hasQueuedChunks(entry)) {
    entry.highPriority = true
    queuedByTerminal.set(terminal, entry)
    scheduleDrain(0)
  } else {
    entry.highPriority = false
    clearForegroundRelease(entry)
  }
  recordQueueDebugPressure()
}

function requestRegisteredTerminalBacklogRecovery(terminal: TerminalOutputTarget): boolean {
  const requestRecovery = backlogRecoveryByTerminal.get(terminal)
  if (!requestRecovery) {
    return false
  }
  return requestRecovery()
}

export function requestTerminalBacklogRecovery(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  requestRegisteredTerminalBacklogRecovery(terminal)
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

export function waitForTerminalOutputParsed(terminal: TerminalOutputTarget): Promise<void> {
  flushTerminalOutput(terminal)
  if (isTerminalWritePipelineCertifiedDead(terminal)) {
    // Why: a dead pipeline cannot settle; recovery owns it and serializers must not enqueue probe writes during a pending remount retry.
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      resolve()
    }
    const finishParsed = (): void => {
      // Why: serializer/startup probes share xterm's FIFO with replay guards; their completion is real parser progress despite carrying no bytes.
      recordTerminalParseProgress(terminal)
      finish()
    }
    timer = setTimeout(finish, PARSE_SETTLE_TIMEOUT_MS)
    try {
      terminal.write('', finishParsed)
    } catch {
      // Why: a synchronous rejection means this xterm can't accept even an empty FIFO probe; recovery must replace it before reuse.
      failTerminalWriteStallWatch(terminal)
      finish()
    }
  })
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

exposeDebugApi()
