import {
  failTerminalWriteStallWatch,
  isTerminalWritePipelineCertifiedDead,
  recordTerminalParseProgress
} from './terminal-write-pipeline-health'
import { exposeTerminalOutputSchedulerDebugApi as exposeDebugApi } from './pane-terminal-output-scheduler-debug'
import { flushTerminalOutputImpl } from './pane-terminal-output-flusher'
import { writeTerminalOutputImpl } from './pane-terminal-output-writer'
import {
  requestRegisteredTerminalBacklogRecovery,
  type TerminalOutputTarget,
  type WriteTerminalOutputOptions
} from './pane-terminal-output-queue-registry'
// Why this bare import: pane-terminal-output-drain registers the drain runner that the registry's
// scheduleDrain invokes, and this facade is every consumer's entry point into the scheduler graph.
import './pane-terminal-output-drain'

export {
  ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY,
  BACKGROUND_BACKLOG_WARNING,
  BACKGROUND_CHUNK_CHARS,
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_FLUSH_DELAY_MS,
  DRAIN_TIME_BUDGET_MS,
  FOREGROUND_BACKLOG_WARNING,
  HIGH_PRIORITY_DRAIN_INTERVAL_MS,
  HIGH_PRIORITY_MAX_WRITES_PER_DRAIN,
  LARGE_BACKLOG_CHARS,
  MAX_BACKGROUND_QUEUE_CHUNKS,
  MAX_WRITES_PER_DRAIN,
  configureTerminalOutputBacklogCap,
  discardTerminalOutput,
  getTerminalOutputMaxQueueChars,
  isMessageChannelDrainEnabled,
  markTerminalOutputDrainStarted,
  queuedByTerminal,
  registerTerminalBacklogRecovery,
  requestRegisteredTerminalBacklogRecovery,
  scheduleDrain,
  setUseMessageChannelDrainForTesting,
  type QueueEntry,
  type QueuedWrite,
  type TerminalOutputBeforeWrite,
  type TerminalOutputParsedCallback,
  type TerminalOutputTarget,
  type WriteTerminalOutputOptions
} from './pane-terminal-output-queue-registry'

const PARSE_SETTLE_TIMEOUT_MS = 250

export function writeTerminalOutput(
  terminal: TerminalOutputTarget,
  data: string,
  options: WriteTerminalOutputOptions
): void {
  writeTerminalOutputImpl(terminal, data, options)
}

export function flushTerminalOutput(
  terminal: TerminalOutputTarget,
  options?: { maxChars?: number }
): void {
  flushTerminalOutputImpl(terminal, options)
}

export function requestTerminalBacklogRecovery(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  requestRegisteredTerminalBacklogRecovery(terminal)
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

exposeDebugApi()
