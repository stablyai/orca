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

export function composeParsedCallback(
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
