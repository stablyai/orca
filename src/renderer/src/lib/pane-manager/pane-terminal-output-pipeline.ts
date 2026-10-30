import { writeForegroundTerminalChunk } from './pane-terminal-foreground-render-settle'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'
import { registerTerminalOutputAckCredits } from './pane-terminal-output-ack-credit'
import {
  armTerminalWriteStallWatch,
  cancelTerminalWriteStallWatch,
  failTerminalWriteStallWatch,
  isTerminalWritePipelineCertifiedDead,
  settleTerminalWriteStallWatch
} from './terminal-write-pipeline-health'
import { removeTransientCursorShowSequences } from './pane-terminal-cursor-sequencing'
import { takeQueuedChunk } from './pane-terminal-output-queue-chunks'
import { recordTerminalOutputQueueDebugPressure as recordQueueDebugPressure } from './pane-terminal-output-scheduler-debug'
import { clearForegroundRelease } from './pane-terminal-foreground-queue-state'
import {
  BACKGROUND_CHUNK_CHARS,
  discardTerminalOutput,
  fireQueuedAckCredits,
  queuedByTerminal,
  scheduleDrain,
  type QueueEntry,
  type TerminalOutputParsedCallback,
  type TerminalOutputTarget
} from './pane-terminal-output-queue-registry'
import {
  discardDetachedQueueEntry,
  hasHighPriorityBacklog
} from './pane-terminal-output-queue-backlog'

// Why no per-write scroll enforcement: xterm's BufferService.isUserScrolling owns live follow/pin; app-side enforcement is limited to structural ops xterm can't identify, like replay.
export function writeBackgroundTerminalChunk(
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

// Parse-clock visible drains at zero delay instead of limiting xterm to fixed 4/16ms cadence; retain bounded background cadence to protect focus.
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

export function composeParsedCallback(
  terminal: TerminalOutputTarget,
  onParsed: TerminalOutputParsedCallback | undefined,
  ackCreditsParsed: (() => void) | undefined,
  pacer: (() => void) | undefined
): TerminalOutputParsedCallback {
  // Always provide completion: it settles pipeline health, avoiding a needless probe round-trip for every healthy idle pane.
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

export function composeWriteFailureCallback(
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

export function writeQueuedChunk(entry: QueueEntry): 'foreground' | 'background' | null {
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
  // Arm before writing: wedged WriteBuffer (#2836) or disposed xterm can omit parsed callbacks entirely.
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
