import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../../shared/agent-detection'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

// Why: the read must land after the shell has exec'd the command; and when it
// still sees a node/python wrapper, the daemon resolves that ancestry
// asynchronously, so give its cache one bounded re-read — not a retry ladder.
const COMMAND_SETTLE_MS = 350
const WRAPPER_RESOLVE_RETRY_MS = 1200

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
 * changes), and a no-RPC shell-foreground mark when it finishes — 133;D itself
 * proves the command exited back to the prompt.
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

  const scheduleRead = (delayMs: number, allowWrapperRetry: boolean): void => {
    const generation = readGeneration
    readTimer = window.setTimeout(() => {
      readTimer = null
      void readForeground(generation, allowWrapperRetry)
    }, delayMs)
  }

  async function readForeground(generation: number, allowWrapperRetry: boolean): Promise<void> {
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
    if (processName && isShellProcess(processName)) {
      deps.publish({ agent: null, shellForeground: true })
      return
    }
    if (allowWrapperRetry && processName) {
      scheduleRead(WRAPPER_RESOLVE_RETRY_MS, false)
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
      scheduleRead(COMMAND_SETTLE_MS, true)
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
