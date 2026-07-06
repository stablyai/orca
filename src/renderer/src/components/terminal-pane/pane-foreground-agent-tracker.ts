import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

// Why: the read must land after the shell has exec'd the command; and when it
// still sees a node/python wrapper, the daemon resolves that ancestry
// asynchronously — observed to take >1.5s for real node-wrapped CLIs — so
// give its cache two bounded re-reads, not an open-ended retry loop.
const COMMAND_SETTLE_MS = 350
const VISIBLE_PTY_SETTLE_MS = 350
const WRAPPER_RESOLVE_RETRY_DELAYS_MS = [1200, 3500] as const
type ForegroundReadReason = 'command' | 'visible-pty' | 'command-finished'

type PaneForegroundAgentTrackerDeps = {
  getPtyId: () => string | null
  /** Local panes only — remote/SSH foreground reads are expensive RPCs and
   *  their replayed OSC streams must not produce process evidence. */
  isTrackablePtyId: (ptyId: string) => boolean
  readForegroundProcess: (ptyId: string) => Promise<string | null>
  publish: (entry: PaneForegroundAgentEntry) => void
  /** True when the pane is otherwise known to run an agent (launchAgent, live
   *  hook status). Lets a restored agent pane confirm — rather than trust — a
   *  133;D before any command-start read has recorded its own evidence. */
  hasKnownAgentIdentity?: () => boolean
  /** Fired when a confirming read proves the foreground genuinely returned to a
   *  shell (agent exited). Lets callers clear a stale agent-named tab title that
   *  the shell never repaints. */
  onConfirmedShellForeground?: () => void
}

/**
 * Publishes process-table identity for a pane at OSC 133 command boundaries:
 * one foreground read when a command starts (that is when the foreground
 * changes), and a shell-foreground mark when it finishes. A 133;D is normally
 * the shell-foreground proof; for a pane an agent has owned it is confirmed by a
 * foreground read first, because a full-screen agent's nested command shells
 * leak their own 133;D onto the main PTY.
 */
export function createPaneForegroundAgentTracker(deps: PaneForegroundAgentTrackerDeps): {
  onVisiblePtyBound: () => void
  onCommandStarted: () => void
  onCommandFinished: () => void
  dispose: () => void
} {
  let disposed = false
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledReadReason: ForegroundReadReason | null = null
  let activeReadReason: ForegroundReadReason | null = null
  let readGeneration = 0
  // Why: a full-screen agent (Codex, etc.) runs nested command shells whose own
  // OSC 133;D leaks onto the main PTY. For a pane an agent has owned, that D is
  // not proof the prompt returned, so confirm the foreground before clearing.
  let hasForegroundAgentEvidence = false

  const trackablePtyId = (): string | null => {
    const ptyId = deps.getPtyId()
    return ptyId && deps.isTrackablePtyId(ptyId) ? ptyId : null
  }

  const cancelPendingRead = (): void => {
    readGeneration += 1
    if (readTimer !== null) {
      clearTimeout(readTimer)
      readTimer = null
    }
    scheduledReadReason = null
    activeReadReason = null
  }

  const scheduleRead = (
    delayMs: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): void => {
    const generation = readGeneration
    scheduledReadReason = reason
    readTimer = setTimeout(() => {
      readTimer = null
      scheduledReadReason = null
      activeReadReason = reason
      void readForeground(generation, retryIndex, reason).finally(() => {
        if (generation === readGeneration && activeReadReason === reason) {
          activeReadReason = null
        }
      })
    }, delayMs)
  }

  async function readForeground(
    generation: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): Promise<void> {
    const ptyId = trackablePtyId()
    if (disposed || generation !== readGeneration || !ptyId) {
      return
    }
    let processName: string | null = null
    try {
      processName = await deps.readForegroundProcess(ptyId)
    } catch {
      processName = null
    }
    if (disposed || generation !== readGeneration) {
      return
    }
    const recognized = recognizeAgentProcess(processName)
    if (recognized) {
      hasForegroundAgentEvidence = true
      deps.publish({ agent: recognized.agent, shellForeground: false })
      return
    }
    // Why: a shell seen here is NOT prompt proof — 133;D cancels pending reads,
    // so a still-live generation means the command is running and the shell is
    // a nested one (sh/bash without integration); marking shell-foreground
    // would suppress live title identity. Only 133;D proves the prompt.
    const retryDelay = WRAPPER_RESOLVE_RETRY_DELAYS_MS[retryIndex]
    const shouldRetry =
      retryDelay !== undefined &&
      processName &&
      (reason === 'command' || isAgentForegroundWrapperProcess(processName))
    if (shouldRetry) {
      scheduleRead(retryDelay, retryIndex + 1, reason)
      return
    }
    if (reason === 'command') {
      deps.publish({ agent: null, shellForeground: false })
      return
    }
    if (reason === 'command-finished') {
      // Why: the 133;D fired AND the foreground shows no agent — together that is
      // real prompt proof, so the agent truly exited. Reset the evidence so the
      // pane's ordinary shell commands go back to the no-RPC finished path.
      hasForegroundAgentEvidence = false
      deps.publish({ agent: null, shellForeground: true })
      // Why: confirmed exit — let callers clear a stale agent title the shell
      // won't repaint (a plain `codex`/`grok` leaves its OSC title behind).
      deps.onConfirmedShellForeground?.()
    }
  }

  return {
    onVisiblePtyBound() {
      // Why: command-start and command-finished reads own the exit decision;
      // visibility recovery is lower-authority and must never cancel them.
      if (
        scheduledReadReason === 'command' ||
        activeReadReason === 'command' ||
        scheduledReadReason === 'command-finished' ||
        activeReadReason === 'command-finished'
      ) {
        return
      }
      cancelPendingRead()
      if (!trackablePtyId()) {
        return
      }
      // Why: restored/manual agent panes can become visible while Codex is
      // already foreground, so no OSC 133 command-start event will seed the tab icon.
      scheduleRead(VISIBLE_PTY_SETTLE_MS, 0, 'visible-pty')
    },
    onCommandStarted() {
      cancelPendingRead()
      if (!trackablePtyId()) {
        return
      }
      // Why: the foreground left the prompt the moment C fired — stale
      // shell-foreground evidence must not clear the command that just started.
      deps.publish({ agent: null, shellForeground: false })
      scheduleRead(COMMAND_SETTLE_MS, 0, 'command')
    },
    onCommandFinished() {
      // Why: a rapid 133;C→133;D pair cancels the command-start read before it
      // can identify the foreground — that pair is exactly a leaked nested-shell
      // command under a full-screen agent (or a fast real shell command), so on a
      // no-identity pane confirm it rather than trusting the D as a prompt return.
      // A pending confirming read counts too: user shell integrations double up
      // Orca's OSC 133, and the duplicate D must re-confirm, not fast-path past
      // the in-flight confirmation it just cancelled.
      const commandReadWasPending =
        scheduledReadReason === 'command' ||
        activeReadReason === 'command' ||
        scheduledReadReason === 'command-finished' ||
        activeReadReason === 'command-finished'
      cancelPendingRead()
      if (!trackablePtyId()) {
        return
      }
      // Why: trust the 133;D and mark shell without an RPC only when nothing hints
      // at an agent — no prior agent evidence, no launch/hook identity, and no
      // command-start read racing this finish.
      if (
        !hasForegroundAgentEvidence &&
        deps.hasKnownAgentIdentity?.() !== true &&
        !commandReadWasPending
      ) {
        deps.publish({ agent: null, shellForeground: true })
        return
      }
      // Why: confirm the foreground before clearing — if the agent still owns it,
      // the read republishes its identity; only a genuine shell result clears it.
      scheduleRead(COMMAND_SETTLE_MS, 0, 'command-finished')
    },
    dispose() {
      disposed = true
      cancelPendingRead()
    }
  }
}
