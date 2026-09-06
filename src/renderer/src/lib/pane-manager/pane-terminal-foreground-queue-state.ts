import {
  queuedByTerminal,
  scheduleDrain,
  type QueueEntry,
  type TerminalOutputTarget,
  type WriteTerminalOutputOptions
} from './pane-terminal-output-queue-registry'

const DEFAULT_FOREGROUND_COALESCE_DELAY_MS = 1000
export const FOREGROUND_HOLD_SAFETY_DELAY_MS = 250
export const LATENCY_SENSITIVE_FOREGROUND_COALESCE_DELAY_MS = 16
export const LATENCY_SENSITIVE_FOREGROUND_HOLD_SAFETY_DELAY_MS = 32

export function createQueueEntry(
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
    foregroundCoalesceDelayMs: DEFAULT_FOREGROUND_COALESCE_DELAY_MS,
    foregroundHoldSafetyTimer: null,
    foregroundCoalesceTimer: null,
    foregroundReleaseDeadlineAt: null,
    foregroundReleaseDeadlineFixed: false
  }
}

function getDrainNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

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

export function clearForegroundRelease(entry: QueueEntry): void {
  clearForegroundHoldSafety(entry)
  clearForegroundCoalesce(entry)
  resetForegroundReleaseGate(entry)
}

export function clearForegroundHoldSafety(entry: QueueEntry): void {
  if (entry.foregroundHoldSafetyTimer === null) {
    return
  }
  clearTimeout(entry.foregroundHoldSafetyTimer)
  entry.foregroundHoldSafetyTimer = null
  entry.foregroundHoldSafetyDelayMs = FOREGROUND_HOLD_SAFETY_DELAY_MS
}

export function clearForegroundCoalesce(entry: QueueEntry): void {
  if (entry.foregroundCoalesceTimer !== null) {
    clearTimeout(entry.foregroundCoalesceTimer)
    entry.foregroundCoalesceTimer = null
  }
  entry.foregroundCoalesce = false
  entry.foregroundCoalesceDelayMs = DEFAULT_FOREGROUND_COALESCE_DELAY_MS
}

export function scheduleForegroundHoldSafety(entry: QueueEntry): void {
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

export function scheduleForegroundCoalesceRelease(
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

export function isEntryDrainable(entry: QueueEntry): boolean {
  return !entry.foregroundHold && !entry.foregroundCoalesce
}
