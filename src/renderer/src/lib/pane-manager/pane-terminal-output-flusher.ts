import { writeForegroundTerminalChunk } from './pane-terminal-foreground-render-settle'
import { registerTerminalOutputAckCredits } from './pane-terminal-output-ack-credit'
import {
  armTerminalWriteStallWatch,
  cancelTerminalWriteStallWatch,
  isTerminalWritePipelineCertifiedDead
} from './terminal-write-pipeline-health'
import { removeTransientCursorShowSequences } from './pane-terminal-cursor-sequencing'
import { takeQueuedChunk } from './pane-terminal-output-queue-chunks'
import {
  exposeTerminalOutputSchedulerDebugApi as exposeDebugApi,
  recordTerminalOutputQueueDebugPressure as recordQueueDebugPressure,
  terminalOutputSchedulerDebugEnabled as debugEnabled,
  terminalOutputSchedulerDebugState as debugState
} from './pane-terminal-output-scheduler-debug'
import {
  composeParsedCallback,
  composeWriteFailureCallback,
  writeBackgroundTerminalChunk
} from './pane-terminal-output-pipeline'
import { discardDetachedQueueEntry, hasQueuedChunks } from './pane-terminal-output-queue-backlog'
import { clearForegroundRelease, isEntryDrainable } from './pane-terminal-foreground-queue-state'
import {
  BACKGROUND_CHUNK_CHARS,
  DENSE_SGR_CHUNK_CHARS,
  canDrainQueueEntry,
  discardTerminalOutput,
  fireQueuedAckCredits,
  queuedByTerminal,
  requestRegisteredTerminalBacklogRecovery,
  scheduleDrain,
  reserveDenseSgrBatch,
  type TerminalOutputTarget
} from './pane-terminal-output-queue-registry'

export function flushTerminalOutputImpl(
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
  if (!canDrainQueueEntry(entry)) {
    queuedByTerminal.set(terminal, entry)
    scheduleDrain(0)
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
  let queuedWrite = takeQueuedChunk(
    entry,
    entry.denseSgr ? DENSE_SGR_CHUNK_CHARS : BACKGROUND_CHUNK_CHARS
  )
  while (queuedWrite) {
    flushedChars += queuedWrite.data.length
    if (debugEnabled) {
      debugState.flushWriteCount++
    }
    const ackCreditsParsed = registerTerminalOutputAckCredits(terminal, queuedWrite.ackCredits)
    const denseSgrRelease = entry.denseSgr ? reserveDenseSgrBatch(terminal) : undefined
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
                undefined,
                denseSgrRelease
              ),
              onWriteFailure: composeWriteFailureCallback(
                terminal,
                ackCreditsParsed,
                denseSgrRelease
              )
            }
          )
        : writeBackgroundTerminalChunk(
            terminal,
            queuedWrite.data,
            composeParsedCallback(
              terminal,
              queuedWrite.onParsed,
              ackCreditsParsed,
              undefined,
              denseSgrRelease
            ),
            composeWriteFailureCallback(terminal, ackCreditsParsed, denseSgrRelease)
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
      denseSgrRelease?.()
      fireQueuedAckCredits(entry)
      clearForegroundRelease(entry)
      recordQueueDebugPressure()
      return
    }
    if (options?.maxChars !== undefined && flushedChars >= options.maxChars) {
      break
    }
    if (entry.denseSgr) {
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
