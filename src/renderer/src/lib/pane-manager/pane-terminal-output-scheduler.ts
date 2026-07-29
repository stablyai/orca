/* oxlint-disable max-lines -- Why: output ordering, foreground settle, queue state, and e2e diagnostics form one state machine; splitting it would make backlog/resume guarantees harder to audit. */
import { e2eConfig } from '@/lib/e2e-config'
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

type TerminalOutputTarget = ForegroundTerminalOutputTarget

type TerminalOutputBeforeWrite = (data: string) => void
type TerminalBacklogRecoveryRequest = () => boolean
type TerminalOutputParsedCallback = () => void
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
  foreground: boolean
  forceForegroundRefresh: boolean
  followupForegroundRefresh: boolean
  shouldRefreshForegroundSynchronously: ForegroundRefreshSyncResolver
  stripTransientCursorShows: boolean
  beforeWrite?: TerminalOutputBeforeWrite
  onParsed?: TerminalOutputParsedCallback
  ackCredit?: () => void
}

type QueuedWrite = {
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

type QueueEntry = {
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
const SYNC_FOREGROUND_FLUSH_CHARS = 256 * 1024
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
const CURSOR_SHOW_SEQUENCE = '\x1b[?25h'
const CURSOR_HIDE_SEQUENCE = '\x1b[?25l'
const SYNCHRONIZED_OUTPUT_END_SEQUENCE = '\x1b[?2026l'
// Why: leading CAN aborts any partial escape sequence before the style reset so the backlog warning renders cleanly.
const BACKGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped hidden terminal output because the backlog grew too large.]\r\n'
// Why a separate foreground message: a visible pane hitting the cap means the drain couldn't keep up with a flood (starved renderer), not merely output produced while hidden.
const FOREGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped a burst of terminal output because the backlog grew too large.]\r\n'
const ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY = (): boolean => true

const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()
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
const debugEnabled = e2eConfig.exposeStore

// Why the cap is lossy: a backgrounded Chromium document throttles timers while PTYs keep writing, so unbounded hidden scrollback would grow renderer memory until the app crashes.

type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  deferredForegroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  deferredForegroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  queuedTerminalCount: number
  queuedChars: number
  peakQueuedTerminalCount: number
  peakQueuedChars: number
  peakQueuedCharsByTerminal: number
  droppedBacklogCount: number
  drainWrites: number[]
}

type TerminalOutputSchedulerDebugApi = {
  reset: () => void
  snapshot: () => TerminalOutputSchedulerDebugSnapshot
}

const debugState: TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: 0,
  deferredForegroundEnqueueCount: 0,
  foregroundWriteCount: 0,
  backgroundWriteCount: 0,
  deferredForegroundWriteCount: 0,
  flushWriteCount: 0,
  scheduledDrainCount: 0,
  queuedTerminalCount: 0,
  queuedChars: 0,
  peakQueuedTerminalCount: 0,
  peakQueuedChars: 0,
  peakQueuedCharsByTerminal: 0,
  droppedBacklogCount: 0,
  drainWrites: []
}

function resetDebugState(): void {
  debugState.backgroundEnqueueCount = 0
  debugState.deferredForegroundEnqueueCount = 0
  debugState.foregroundWriteCount = 0
  debugState.backgroundWriteCount = 0
  debugState.deferredForegroundWriteCount = 0
  debugState.flushWriteCount = 0
  debugState.scheduledDrainCount = 0
  debugState.queuedTerminalCount = 0
  debugState.queuedChars = 0
  debugState.peakQueuedTerminalCount = 0
  debugState.peakQueuedChars = 0
  debugState.peakQueuedCharsByTerminal = 0
  debugState.droppedBacklogCount = 0
  debugState.drainWrites = []
}

function readQueueDebugSnapshot(): {
  queuedTerminalCount: number
  queuedChars: number
  queuedCharsByTerminal: number
} {
  let queuedChars = 0
  let queuedCharsByTerminal = 0
  for (const entry of queuedByTerminal.values()) {
    queuedChars += entry.queuedChars
    queuedCharsByTerminal = Math.max(queuedCharsByTerminal, entry.queuedChars)
  }
  return {
    queuedTerminalCount: queuedByTerminal.size,
    queuedChars,
    queuedCharsByTerminal
  }
}

function recordQueueDebugPressure(): void {
  if (!debugEnabled) {
    return
  }
  const current = readQueueDebugSnapshot()
  debugState.queuedTerminalCount = current.queuedTerminalCount
  debugState.queuedChars = current.queuedChars
  debugState.peakQueuedTerminalCount = Math.max(
    debugState.peakQueuedTerminalCount,
    current.queuedTerminalCount
  )
  debugState.peakQueuedChars = Math.max(debugState.peakQueuedChars, current.queuedChars)
  debugState.peakQueuedCharsByTerminal = Math.max(
    debugState.peakQueuedCharsByTerminal,
    current.queuedCharsByTerminal
  )
}

function exposeDebugApi(): void {
  if (!debugEnabled || typeof window === 'undefined') {
    return
  }
  // Why: the e2e repro must prove background output used the shared drain, but production must not accumulate diagnostic counters indefinitely.
  const target = window as unknown as {
    __terminalOutputSchedulerDebug?: TerminalOutputSchedulerDebugApi
  }
  target.__terminalOutputSchedulerDebug ??= {
    reset: resetDebugState,
    snapshot: () => {
      recordQueueDebugPressure()
      return {
        ...debugState,
        drainWrites: [...debugState.drainWrites]
      }
    }
  }
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
    foregroundCoalesceTimer: null
  }
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
  entry.foregroundHoldSafetyTimer = setTimeout(() => {
    entry.foregroundHoldSafetyTimer = null
    entry.foregroundHold = false
    clearForegroundCoalesce(entry)
    if (queuedByTerminal.has(entry.terminal)) {
      scheduleDrain(0)
    }
  }, entry.foregroundHoldSafetyDelayMs)
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
  entry.foregroundCoalesceTimer = setTimeout(() => {
    entry.foregroundCoalesceTimer = null
    entry.foregroundCoalesce = false
    if (queuedByTerminal.has(entry.terminal)) {
      scheduleDrain(0)
    }
  }, entry.foregroundCoalesceDelayMs)
}

function isEntryDrainable(entry: QueueEntry): boolean {
  return !entry.foregroundHold && !entry.foregroundCoalesce
}

function findCursorPositionSequenceEnd(
  data: string,
  fromIndex: number,
  toIndex = data.length
): number {
  let offset = data.indexOf('\x1b[', fromIndex)
  while (offset !== -1 && offset < toIndex) {
    let index = offset + 2
    while (index < toIndex) {
      const char = data[index]
      if (char === 'G' || char === 'H' || char === 'f') {
        return index + 1
      }
      if ((char < '0' || char > '9') && char !== ';') {
        break
      }
      index += 1
    }
    offset = data.indexOf('\x1b[', offset + 2)
  }
  return -1
}

function removeTransientCursorShowSequences(data: string): string {
  let result = ''
  let offset = 0
  let showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE)
  while (showIndex !== -1) {
    const nextHideIndex = data.indexOf(
      CURSOR_HIDE_SEQUENCE,
      showIndex + CURSOR_SHOW_SEQUENCE.length
    )
    const nextPositionEnd = findCursorPositionSequenceEnd(
      data,
      showIndex + CURSOR_SHOW_SEQUENCE.length,
      nextHideIndex === -1 ? data.length : nextHideIndex
    )
    if (nextHideIndex === -1) {
      if (nextPositionEnd === -1) {
        const synchronizedEndIndex = data.indexOf(
          SYNCHRONIZED_OUTPUT_END_SEQUENCE,
          showIndex + CURSOR_SHOW_SEQUENCE.length
        )
        if (synchronizedEndIndex === -1) {
          break
        }
        // Why: keep the cursor hidden through the synchronized repaint, restoring it after the frame ends so Windows never paints it in the transient draw position.
        result += data.slice(offset, showIndex)
        result += data.slice(
          showIndex + CURSOR_SHOW_SEQUENCE.length,
          synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
        )
        result += CURSOR_SHOW_SEQUENCE
        offset = synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
        showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset)
        continue
      }
      // Why: Codex can show the cursor before its final synchronized-frame placement. Place first so xterm cannot rasterize the stale cell.
      result += data.slice(offset, showIndex)
      result += data.slice(showIndex + CURSOR_SHOW_SEQUENCE.length, nextPositionEnd)
      result += CURSOR_SHOW_SEQUENCE
      offset = nextPositionEnd
      showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset)
      continue
    }
    result += data.slice(offset, showIndex)
    offset = showIndex + CURSOR_SHOW_SEQUENCE.length
    showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset)
  }
  return offset === 0 ? data : result + data.slice(offset)
}

function containsCursorPositionSequence(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    let index = offset + 2
    while (index < data.length) {
      const char = data[index]
      if (char === 'G' || char === 'H' || char === 'f') {
        return true
      }
      if ((char < '0' || char > '9') && char !== ';') {
        break
      }
      index += 1
    }
    offset = data.indexOf('\x1b[', offset + 2)
  }
  return false
}

function containsCursorRestore(data: string): boolean {
  const hideIndex = data.indexOf(CURSOR_HIDE_SEQUENCE)
  const showIndex = data.lastIndexOf(CURSOR_SHOW_SEQUENCE)
  return hideIndex !== -1 && showIndex > hideIndex && containsCursorPositionSequence(data)
}

function containsDrainableCursorRestore(data: string): boolean {
  const synchronizedEndIndex = data.lastIndexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE)
  if (synchronizedEndIndex === -1) {
    return containsCursorRestore(data)
  }
  return containsCursorRestore(
    data.slice(synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length)
  )
}

function containsFinalCursorPlacementBeforeSynchronizedEnd(data: string): boolean {
  const synchronizedEndIndex = data.lastIndexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE)
  if (synchronizedEndIndex === -1) {
    return false
  }
  const lastShowIndex = data.lastIndexOf(CURSOR_SHOW_SEQUENCE, synchronizedEndIndex)
  if (lastShowIndex === -1) {
    return false
  }
  const lastHideIndex = data.lastIndexOf(CURSOR_HIDE_SEQUENCE, synchronizedEndIndex)
  if (lastHideIndex > lastShowIndex) {
    return false
  }
  return (
    findCursorPositionSequenceEnd(
      data,
      lastShowIndex + CURSOR_SHOW_SEQUENCE.length,
      synchronizedEndIndex
    ) !== -1
  )
}

function previewQueuedData(entry: QueueEntry, limit: number): string {
  let data = ''
  for (let index = entry.chunkIndex; index < entry.chunks.length; index += 1) {
    const chunk = entry.chunks[index]
    const remaining = limit - data.length
    if (remaining <= 0) {
      break
    }
    data += chunk.data.slice(0, remaining)
  }
  return data
}

function coalescedQueuedDataNeedsCursorRestore(entry: QueueEntry): boolean {
  const data = previewQueuedData(entry, SYNC_FOREGROUND_FLUSH_CHARS)
  const synchronizedEndIndex = data.lastIndexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE)
  if (synchronizedEndIndex === -1) {
    return false
  }
  const synchronizedFrame = data.slice(
    0,
    synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
  )
  return (
    containsCursorRestore(synchronizedFrame) &&
    !containsFinalCursorPlacementBeforeSynchronizedEnd(synchronizedFrame) &&
    !containsDrainableCursorRestore(data)
  )
}

function takeQueuedChunk(entry: QueueEntry, limit: number): QueuedWrite | null {
  let remaining = limit
  let data = ''
  let foreground: boolean | null = null
  let forceForegroundRefresh = false
  let followupForegroundRefresh = false
  let shouldRefreshForegroundSynchronously: ForegroundRefreshSyncResolver | null = null
  let additionalRefreshSyncResolvers: ForegroundRefreshSyncResolver[] | null = null
  let stripTransientCursorShows = false
  let beforeWrite: TerminalOutputBeforeWrite | undefined
  let additionalBeforeWriteCallbacks: TerminalOutputBeforeWrite[] | null = null
  const parsedCallbacks: TerminalOutputParsedCallback[] = []
  const ackCredits: (() => void)[] = []

  while (remaining > 0 && entry.chunkIndex < entry.chunks.length) {
    const chunk = entry.chunks[entry.chunkIndex]
    if (foreground !== null && chunk.foreground !== foreground) {
      break
    }
    foreground ??= chunk.foreground
    forceForegroundRefresh ||= chunk.forceForegroundRefresh
    followupForegroundRefresh ||= chunk.followupForegroundRefresh
    // Why: one drained write can combine chunks from different renderer states or producers; preserve every forced policy and prep hook.
    if (chunk.forceForegroundRefresh) {
      if (shouldRefreshForegroundSynchronously === null) {
        shouldRefreshForegroundSynchronously = chunk.shouldRefreshForegroundSynchronously
      } else if (
        chunk.shouldRefreshForegroundSynchronously !== shouldRefreshForegroundSynchronously &&
        !additionalRefreshSyncResolvers?.includes(chunk.shouldRefreshForegroundSynchronously)
      ) {
        additionalRefreshSyncResolvers ??= []
        additionalRefreshSyncResolvers.push(chunk.shouldRefreshForegroundSynchronously)
      }
    }
    stripTransientCursorShows ||= chunk.stripTransientCursorShows
    if (!beforeWrite) {
      beforeWrite = chunk.beforeWrite
    } else if (
      chunk.beforeWrite &&
      chunk.beforeWrite !== beforeWrite &&
      !additionalBeforeWriteCallbacks?.includes(chunk.beforeWrite)
    ) {
      additionalBeforeWriteCallbacks ??= []
      additionalBeforeWriteCallbacks.push(chunk.beforeWrite)
    }
    if (chunk.data.length <= remaining) {
      data += chunk.data
      remaining -= chunk.data.length
      entry.queuedChars -= chunk.data.length
      entry.chunkIndex += 1
      if (chunk.onParsed) {
        parsedCallbacks.push(chunk.onParsed)
      }
      if (chunk.ackCredit) {
        ackCredits.push(chunk.ackCredit)
      }
      continue
    }

    data += chunk.data.slice(0, remaining)
    entry.chunks[entry.chunkIndex] = {
      ...chunk,
      data: chunk.data.slice(remaining)
    }
    entry.queuedChars -= remaining
    remaining = 0
  }

  compactConsumedChunks(entry)
  if (entry.queuedChars < 0) {
    entry.queuedChars = 0
  }
  recordQueueDebugPressure()
  return data
    ? {
        data,
        foreground: foreground === true,
        forceForegroundRefresh,
        followupForegroundRefresh,
        shouldRefreshForegroundSynchronously:
          additionalRefreshSyncResolvers && shouldRefreshForegroundSynchronously
            ? () =>
                shouldRefreshForegroundSynchronously() ||
                additionalRefreshSyncResolvers.some((resolve) => resolve())
            : (shouldRefreshForegroundSynchronously ?? ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY),
        stripTransientCursorShows,
        beforeWrite:
          additionalBeforeWriteCallbacks && beforeWrite
            ? (queuedData) => {
                beforeWrite(queuedData)
                for (const callback of additionalBeforeWriteCallbacks) {
                  callback(queuedData)
                }
              }
            : beforeWrite,
        onParsed:
          parsedCallbacks.length > 0
            ? () => {
                for (const callback of parsedCallbacks) {
                  callback()
                }
              }
            : undefined,
        ackCredits
      }
    : null
}

function compactConsumedChunks(entry: QueueEntry): void {
  if (entry.chunkIndex === 0) {
    return
  }
  if (entry.chunkIndex === entry.chunks.length) {
    entry.chunks.length = 0
    entry.chunkIndex = 0
    return
  }
  if (entry.chunkIndex >= 64) {
    entry.chunks.splice(0, entry.chunkIndex)
    entry.chunkIndex = 0
  }
}

function enqueueChunk(
  entry: QueueEntry,
  data: string,
  options?: {
    foreground?: boolean
    forceForegroundRefresh?: boolean
    followupForegroundRefresh?: boolean
    shouldRefreshForegroundSynchronously?: ForegroundRefreshSyncResolver
    stripTransientCursorShows?: boolean
    beforeWrite?: TerminalOutputBeforeWrite
    onParsed?: TerminalOutputParsedCallback
    ackCredit?: () => void
  }
): void {
  entry.chunks.push({
    data,
    foreground: options?.foreground === true,
    forceForegroundRefresh: options?.forceForegroundRefresh === true,
    followupForegroundRefresh: options?.followupForegroundRefresh === true,
    shouldRefreshForegroundSynchronously:
      options?.shouldRefreshForegroundSynchronously ?? ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY,
    stripTransientCursorShows: options?.stripTransientCursorShows === true,
    beforeWrite: options?.beforeWrite,
    onParsed: options?.onParsed,
    ackCredit: options?.ackCredit
  })
  entry.queuedChars += data.length
  recordQueueDebugPressure()
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
  clearForegroundHoldSafety(entry)
  clearForegroundCoalesce(entry)
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
  clearForegroundCoalesce(entry)
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
      clearForegroundHoldSafety(entry)
      clearForegroundCoalesce(entry)
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
    clearForegroundHoldSafety(entry)
    clearForegroundCoalesce(entry)
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
  const maxWrites = hasHighPriorityBacklog()
    ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN
    : MAX_WRITES_PER_DRAIN

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
      clearForegroundCoalesce(entry)
      clearForegroundHoldSafety(entry)
    }
    // Why: xterm parsing and DOM work share the renderer thread with input; keep draining cooperative so WSL/agent output can't pin the UI.
    if (writes > 0 && getDrainNow() - startedAt >= DRAIN_TIME_BUDGET_MS) {
      break
    }
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes)
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
          clearForegroundCoalesce(queued)
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
      clearForegroundCoalesce(queued)
      clearForegroundHoldSafety(queued)
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
    clearForegroundHoldSafety(entry)
    clearForegroundCoalesce(entry)
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
        clearForegroundHoldSafety(entry)
        clearForegroundCoalesce(entry)
        recordQueueDebugPressure()
        return
      }
    } catch {
      // Why: pre-write hooks/setup failed before xterm owned these bytes; cancel the watch, but consumed + abandoned chunks still credit delivery.
      cancelTerminalWriteStallWatch(terminal)
      ackCreditsParsed?.()
      fireQueuedAckCredits(entry)
      clearForegroundHoldSafety(entry)
      clearForegroundCoalesce(entry)
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
    clearForegroundCoalesce(entry)
    clearForegroundHoldSafety(entry)
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
