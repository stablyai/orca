import {
  failTerminalWriteStallWatch,
  isTerminalWritePipelineCertifiedDead,
  recordTerminalParseProgress
} from './terminal-write-pipeline-health'
import { exposeTerminalOutputSchedulerDebugApi } from './pane-terminal-output-scheduler-debug'
import { flushTerminalOutputImpl } from './pane-terminal-output-flusher'
import { writeTerminalOutputImpl } from './pane-terminal-output-writer'
import { writeXtermParseBarrier } from './xterm-parse-barrier'
import { noteTerminalOutputArrival } from './terminal-output-arrival-observer'
import {
  requestRegisteredTerminalBacklogRecovery,
  type WriteTerminalOutputOptions
} from './pane-terminal-output-queue-registry'
import type { ForegroundTerminalOutputTarget } from './pane-terminal-foreground-render-settle'
// Import for registration: drain installs the runner used by scheduleDrain; this facade is every consumer’s graph entry point.
import './pane-terminal-output-drain'

const PARSE_SETTLE_TIMEOUT_MS = 250

export function writeTerminalOutput(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: WriteTerminalOutputOptions
): void {
  if (data) {
    noteTerminalOutputArrival(terminal)
  }
  writeTerminalOutputImpl(terminal, data, options)
}

export function flushTerminalOutput(
  terminal: ForegroundTerminalOutputTarget,
  options?: { maxChars?: number }
): void {
  flushTerminalOutputImpl(terminal, options)
}

export function requestTerminalBacklogRecovery(terminal: ForegroundTerminalOutputTarget): void {
  exposeTerminalOutputSchedulerDebugApi()
  requestRegisteredTerminalBacklogRecovery(terminal)
}

export function waitForTerminalOutputParsed(
  terminal: ForegroundTerminalOutputTarget
): Promise<void> {
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
      writeXtermParseBarrier(terminal, finishParsed)
    } catch {
      // Why: a synchronous rejection means this xterm can't accept even an empty FIFO probe; recovery must replace it before reuse.
      failTerminalWriteStallWatch(terminal)
      finish()
    }
  })
}

exposeTerminalOutputSchedulerDebugApi()
