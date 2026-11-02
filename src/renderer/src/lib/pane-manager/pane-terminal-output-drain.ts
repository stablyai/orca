import {
  recordTerminalOutputQueueDebugPressure as recordQueueDebugPressure,
  terminalOutputSchedulerDebugEnabled as debugEnabled,
  terminalOutputSchedulerDebugState as debugState
} from './pane-terminal-output-scheduler-debug'
import { clearForegroundRelease, isEntryDrainable } from './pane-terminal-foreground-queue-state'
import { hasHighPriorityBacklog, hasQueuedChunks } from './pane-terminal-output-queue-backlog'
import {
  BACKGROUND_DRAIN_INTERVAL_MS,
  DRAIN_TIME_BUDGET_MS,
  HIGH_PRIORITY_DRAIN_INTERVAL_MS,
  HIGH_PRIORITY_MAX_WRITES_PER_DRAIN,
  LARGE_BACKLOG_CHARS,
  MAX_WRITES_PER_DRAIN,
  isMessageChannelDrainEnabled,
  markTerminalOutputDrainStarted,
  queuedByTerminal,
  scheduleDrain,
  setTerminalOutputDrainRunner,
  type QueueEntry
} from './pane-terminal-output-queue-registry'

import { writeQueuedChunk } from './pane-terminal-output-pipeline'

function hasDrainableBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (isEntryDrainable(entry)) {
      return true
    }
  }
  return false
}

// Why no per-write scroll enforcement: xterm's BufferService.isUserScrolling owns live follow/pin; app-side enforcement is limited to structural ops xterm can't identify, like replay.

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

// Parse-clock visible drains at zero delay to approach xterm throughput; fixed 4/16ms cadence limits it. Keep background cadence bounded to protect focus.

function getDrainNow(): number {
  if (typeof performance !== 'undefined') {
    return performance.now()
  }
  return Date.now()
}

export function drainQueuedOutputImpl(): void {
  markTerminalOutputDrainStarted()
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
    // Yield cooperatively: xterm parsing and input share the renderer thread, so output floods must not pin it.
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
    // Posted messages already yield to input/paint; add no 4ms delay. Keep timer cadence for fake-timer tests.
    scheduleDrain(
      hasHighPriorityBacklog()
        ? isMessageChannelDrainEnabled()
          ? 0
          : HIGH_PRIORITY_DRAIN_INTERVAL_MS
        : BACKGROUND_DRAIN_INTERVAL_MS
    )
  }
}

// Register at module evaluation so scheduleDrain cannot run before its downstream runner exists.
setTerminalOutputDrainRunner(drainQueuedOutputImpl)
