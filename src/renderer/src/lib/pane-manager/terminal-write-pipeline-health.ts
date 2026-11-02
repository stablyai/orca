// WriteBuffer can wedge after callback throws (#2836), while disposed xterm silently drops completions (6.1.0-beta.287); both freeze output and leak ACKs despite live PTYs. Certify with an empty FIFO probe: completion proves prior work drained; silence across a full interval with no parse progress requests terminal remount/PTY reattach.

import { writeXtermParseBarrier } from './xterm-parse-barrier'

type WriteTarget = {
  write(data: string | Uint8Array, callback?: () => void): void
}

export type UndeliverableWriteReason = 'write-stalled' | 'replay-wedged'

type UndeliverableWriteHandler = (reason: UndeliverableWriteReason) => void

const handlersByTerminal = new WeakMap<WriteTarget, UndeliverableWriteHandler>()
const certifiedDeadTerminals = new WeakSet<WriteTarget>()
// Use terminal-scoped generations to distinguish dead from behind without clock adjustments/same-ms misses or hot-path cost.
const parseProgressGenerationByTerminal = new WeakMap<WriteTarget, number>()

/** Report one parsed write completion for this terminal. */
export function recordTerminalParseProgress(terminal: WriteTarget): void {
  const nextGeneration = (parseProgressGenerationByTerminal.get(terminal) ?? 0) + 1
  parseProgressGenerationByTerminal.set(terminal, nextGeneration)
}

/** Capture the current parse-progress generation for a later quiet-window check. */
export function captureTerminalParseProgressGeneration(terminal: WriteTarget): number {
  return parseProgressGenerationByTerminal.get(terminal) ?? 0
}

/** Whether a write completion parsed after `generation` was captured. */
export function hasTerminalParseProgressSince(terminal: WriteTarget, generation: number): boolean {
  return captureTerminalParseProgressGeneration(terminal) !== generation
}

type StallWatchMode = 'output-completion' | 'fifo-probe'

type StallWatch = {
  timer: ReturnType<typeof setTimeout>
  onCertifiedDead?: () => void
  mode: StallWatchMode
}

const stallWatchByTerminal = new WeakMap<WriteTarget, StallWatch>()

export const WRITE_PIPELINE_STALL_CHECK_MS = 10_000

function certifyTerminalWritePipelineDead(terminal: WriteTarget, expectedWatch?: StallWatch): void {
  const watch = stallWatchByTerminal.get(terminal)
  // Only the active watch may certify; real progress can remove it before a stale probe deadline runs.
  if (expectedWatch && watch !== expectedWatch) {
    return
  }
  if (watch) {
    stallWatchByTerminal.delete(terminal)
    try {
      watch.onCertifiedDead?.()
    } catch {
      // Discard can fail on partial IPC surfaces; still notify recovery after cleanup failure.
    }
  }
  notifyUndeliverableWrite(terminal, 'write-stalled')
}

export function registerUndeliverableWriteHandler(
  terminal: WriteTarget,
  handler: UndeliverableWriteHandler
): () => void {
  handlersByTerminal.set(terminal, handler)
  return () => {
    if (handlersByTerminal.get(terminal) === handler) {
      handlersByTerminal.delete(terminal)
    }
  }
}

/** Notify once per terminal instance; recovery replaces it, so further notifications duplicate work. */
export function notifyUndeliverableWrite(
  terminal: WriteTarget,
  reason: UndeliverableWriteReason
): void {
  if (certifiedDeadTerminals.has(terminal)) {
    return
  }
  certifiedDeadTerminals.add(terminal)
  try {
    handlersByTerminal.get(terminal)?.(reason)
  } catch {
    // Contain notification throws from timer/write callbacks; recovery remains best-effort (terminal-pane-recovery.ts).
  }
}

export function isTerminalWritePipelineCertifiedDead(terminal: WriteTarget): boolean {
  return certifiedDeadTerminals.has(terminal)
}

/** Watch issued writes until completion; stall triggers an empty FIFO probe. Completed probes prove slow progress; another silent interval without parse progress certifies death and notifies recovery, as replay-guard.ts does. */
function armTerminalWritePipelineWatch(
  terminal: WriteTarget,
  options: {
    mode: StallWatchMode
    onCertifiedDead?: () => void
    stallCheckMs?: number
  }
): void {
  if (certifiedDeadTerminals.has(terminal)) {
    return
  }
  const existingWatch = stallWatchByTerminal.get(terminal)
  if (existingWatch) {
    if (options.mode === 'fifo-probe') {
      existingWatch.mode = 'fifo-probe'
    }
    return
  }
  const stallCheckMs = options.stallCheckMs ?? WRITE_PIPELINE_STALL_CHECK_MS
  const watch: StallWatch = {
    mode: options.mode,
    onCertifiedDead: options.onCertifiedDead,
    timer: setTimeout(probeForStall, stallCheckMs)
  }
  const certifyDead = (): void => certifyTerminalWritePipelineDead(terminal, watch)
  function armProbeQuietWindow(quietSinceGeneration: number): void {
    watch.timer = setTimeout(() => {
      if (stallWatchByTerminal.get(terminal) !== watch) {
        return
      }
      if (hasTerminalParseProgressSince(terminal, quietSinceGeneration)) {
        armProbeQuietWindow(captureTerminalParseProgressGeneration(terminal))
        return
      }
      certifyDead()
    }, stallCheckMs)
  }
  function probeForStall(): void {
    if (stallWatchByTerminal.get(terminal) !== watch) {
      return
    }
    const probeQueuedAtGeneration = captureTerminalParseProgressGeneration(terminal)
    try {
      writeXtermParseBarrier(terminal, () => {
        // Auxiliary FIFO probes prove progress for terminal-scoped replay guards too.
        recordTerminalParseProgress(terminal)
        // A parsed probe proves liveness; disarm and let the next write rearm.
        const current = stallWatchByTerminal.get(terminal)
        if (current === watch) {
          clearTimeout(current.timer)
          stallWatchByTerminal.delete(terminal)
        }
      })
    } catch {
      certifyDead()
      return
    }
    if (stallWatchByTerminal.get(terminal) === watch) {
      armProbeQuietWindow(probeQueuedAtGeneration)
    }
  }
  stallWatchByTerminal.set(terminal, watch)
}

export function armTerminalWriteStallWatch(
  terminal: WriteTarget,
  options: { onCertifiedDead?: () => void; stallCheckMs?: number } = {}
): void {
  armTerminalWritePipelineWatch(terminal, { ...options, mode: 'output-completion' })
}

/** Require the active watch to reach its FIFO probe before it may settle. */
export function requestTerminalWritePipelineProbe(
  terminal: WriteTarget,
  options: { stallCheckMs?: number } = {}
): void {
  armTerminalWritePipelineWatch(terminal, { ...options, mode: 'fifo-probe' })
}

/** Cancel a pending watch without claiming that any bytes parsed. */
export function cancelTerminalWriteStallWatch(terminal: WriteTarget): void {
  const watch = stallWatchByTerminal.get(terminal)
  if (!watch) {
    return
  }
  clearTimeout(watch.timer)
  stallWatchByTerminal.delete(terminal)
}

/** Write completed normally — the pipeline is healthy; drop any pending watch. */
export function settleTerminalWriteStallWatch(terminal: WriteTarget): void {
  recordTerminalParseProgress(terminal)
  if (stallWatchByTerminal.get(terminal)?.mode === 'fifo-probe') {
    return
  }
  cancelTerminalWriteStallWatch(terminal)
}

/** A synchronous terminal.write failure proves the pipeline cannot accept the
 *  issued bytes. Recover immediately without reporting fake parse progress. */
export function failTerminalWriteStallWatch(terminal: WriteTarget): void {
  certifyTerminalWritePipelineDead(terminal)
}

export function _resetWritePipelineHealthForTests(terminal?: WriteTarget): void {
  if (terminal) {
    const watch = stallWatchByTerminal.get(terminal)
    if (watch) {
      clearTimeout(watch.timer)
    }
    stallWatchByTerminal.delete(terminal)
    handlersByTerminal.delete(terminal)
    certifiedDeadTerminals.delete(terminal)
    parseProgressGenerationByTerminal.delete(terminal)
  }
}
