import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

// Why: the read must land after the shell has exec'd the command; and when it
// still sees a node/python wrapper, the daemon resolves that ancestry
// asynchronously — observed to take >1.5s for real node-wrapped CLIs — so
// give its cache two bounded re-reads, not an open-ended retry loop.
const COMMAND_SETTLE_MS = 350
const WRAPPER_RESOLVE_RETRY_DELAYS_MS = [1200, 3500] as const

type PaneForegroundAgentTrackerDeps = {
  getPtyId: () => string | null
  /** Local panes only — remote/SSH foreground reads are expensive RPCs and
   *  their replayed OSC streams must not produce process evidence. */
  isTrackablePtyId: (ptyId: string) => boolean
  readForegroundProcess: (ptyId: string) => Promise<string | null>
  publish: (entry: PaneForegroundAgentEntry) => void
}

/**
 * Publishes process-table identity for a pane at OSC 133 command boundaries:
 * one foreground read when a command starts (that is when the foreground
 * changes), and a no-RPC shell-foreground mark when it finishes — 133;D is
 * the ONLY source of shell-foreground proof; reads never produce it.
 */
export function createPaneForegroundAgentTracker(deps: PaneForegroundAgentTrackerDeps): {
  onCommandStarted: () => void
  onCommandFinished: () => void
  dispose: () => void
} {
  let disposed = false
  let readTimer: number | null = null
  let readGeneration = 0

  const trackablePtyId = (): string | null => {
    const ptyId = deps.getPtyId()
    return ptyId && deps.isTrackablePtyId(ptyId) ? ptyId : null
  }

  const cancelPendingRead = (): void => {
    readGeneration += 1
    if (readTimer !== null) {
      window.clearTimeout(readTimer)
      readTimer = null
    }
  }

  const scheduleRead = (delayMs: number, retryIndex: number): void => {
    const generation = readGeneration
    readTimer = window.setTimeout(() => {
      readTimer = null
      void readForeground(generation, retryIndex)
    }, delayMs)
  }

  async function readForeground(generation: number, retryIndex: number): Promise<void> {
    const ptyId = trackablePtyId()
    if (disposed || generation !== readGeneration || !ptyId) {
      return
    }
    const processName = await deps.readForegroundProcess(ptyId).catch(() => null)
    if (disposed || generation !== readGeneration) {
      return
    }
    const recognized = recognizeAgentProcess(processName)
    if (recognized) {
      deps.publish({ agent: recognized.agent, shellForeground: false })
      return
    }
    // Why: a shell seen here is NOT prompt proof — 133;D cancels pending reads,
    // so a still-live generation means the command is running and the shell is
    // a nested one (sh/bash without integration); marking shell-foreground
    // would suppress live title identity. Only 133;D proves the prompt.
    const retryDelay = WRAPPER_RESOLVE_RETRY_DELAYS_MS[retryIndex]
    if (retryDelay !== undefined && processName) {
      scheduleRead(retryDelay, retryIndex + 1)
      return
    }
    deps.publish({ agent: null, shellForeground: false })
  }

  return {
    onCommandStarted() {
      cancelPendingRead()
      if (!trackablePtyId()) {
        return
      }
      // Why: the foreground left the prompt the moment C fired — stale
      // shell-foreground evidence must not clear the command that just started.
      deps.publish({ agent: null, shellForeground: false })
      scheduleRead(COMMAND_SETTLE_MS, 0)
    },
    onCommandFinished() {
      cancelPendingRead()
      if (!trackablePtyId()) {
        return
      }
      deps.publish({ agent: null, shellForeground: true })
    },
    dispose() {
      disposed = true
      cancelPendingRead()
    }
  }
}
