import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import type { TuiAgent } from '../../../../shared/types'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

// Why: settle after exec, then place the final generic retry beyond sequential
// 3s PowerShell and WMIC enrichment scans.
const COMMAND_SETTLE_MS = 350
const VISIBLE_PTY_SETTLE_MS = 350
const WRAPPER_RESOLVE_RETRY_DELAYS_MS = [1200, 6000] as const
type ForegroundReadReason = 'command' | 'visible-pty' | 'command-finished'

type PaneForegroundAgentTrackerDeps = {
  getPtyId: () => string | null
  /** Local panes only — remote/SSH foreground reads are expensive RPCs and
   *  their replayed OSC streams must not produce process evidence. */
  isTrackablePtyId: (ptyId: string) => boolean
  readForegroundProcess: (ptyId: string) => Promise<string | null>
  /** Fresh, provider-owned evidence used only when input routing may change. */
  confirmForegroundProcess?: (ptyId: string) => Promise<string | null>
  publish: (entry: PaneForegroundAgentEntry) => void
  /** True when the pane is otherwise known to run an agent (launchAgent, live
   *  hook status). Lets a restored agent pane confirm — rather than trust — a
   *  133;D before any command-start read has recorded its own evidence. */
  hasKnownAgentIdentity?: () => boolean
  /** Fired when a confirming read proves the foreground genuinely returned to a
   *  shell (agent exited). Lets callers clear a stale agent-named tab title that
   *  the shell never repaints. */
  onConfirmedShellForeground?: (reason: 'visible-pty' | 'command-finished') => void
  onCommandFinishedUnavailable?: () => void
  onVisibleForegroundSettled?: (outcome: 'agent' | 'shell' | 'inconclusive') => void
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
  onVisiblePtyBound: (expectsAgent?: boolean) => boolean
  onCommandStarted: (expectedAgent?: TuiAgent | null) => void
  /** True when pane identity must remain visible until an async shell confirmation. */
  onCommandFinished: () => boolean
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
  // Why: latch launch/hook evidence until confirmation finishes so cleanup
  // cannot remove the identity that authorizes the bounded retry ladder.
  let hasKnownAgentEvidence = false
  let hasAgentExpectation = false

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
    const requiresRoutingConfirmation =
      reason === 'command-finished' ||
      hasForegroundAgentEvidence ||
      hasKnownAgentEvidence ||
      hasAgentExpectation
    try {
      processName = await (requiresRoutingConfirmation
        ? (deps.confirmForegroundProcess ?? deps.readForegroundProcess)(ptyId)
        : deps.readForegroundProcess(ptyId))
    } catch {
      processName = null
    }
    // Why: a pane key can be rebound while process inspection is pending; the
    // old PTY's identity must never publish into its replacement session.
    if (disposed || generation !== readGeneration || trackablePtyId() !== ptyId) {
      return
    }
    const recognized = recognizeAgentProcess(processName)
    if (recognized) {
      hasForegroundAgentEvidence = true
      hasAgentExpectation = false
      deps.publish({
        agent: recognized.agent,
        shellForeground: false,
        ...(requiresRoutingConfirmation ? { routingTrusted: true } : {})
      })
      if (reason === 'visible-pty') {
        deps.onVisibleForegroundSettled?.('agent')
      }
      return
    }
    // Why: a shell seen here is NOT prompt proof — 133;D cancels pending reads,
    // so a still-live generation means the command is running and the shell is
    // a nested one (sh/bash without integration); marking shell-foreground
    // would suppress live title identity. Only 133;D proves the prompt.
    const retryDelay = WRAPPER_RESOLVE_RETRY_DELAYS_MS[retryIndex]
    const hasConfirmationExpectation =
      hasForegroundAgentEvidence || hasKnownAgentEvidence || hasAgentExpectation
    const shouldRetryExpectedIdentity =
      hasConfirmationExpectation && (reason !== 'command-finished' || processName === null)
    const shouldRetry =
      retryDelay !== undefined &&
      (shouldRetryExpectedIdentity ||
        (processName !== null &&
          (reason === 'command' || isAgentForegroundWrapperProcess(processName))))
    if (shouldRetry) {
      // Why: provisional PowerShell may hide a live agent; the bounded ladder
      // spans PowerShell-to-WMIC enrichment without becoming a polling loop.
      scheduleRead(retryDelay, retryIndex + 1, reason)
      return
    }
    if (reason === 'command') {
      hasAgentExpectation = false
      deps.publish({ agent: null, shellForeground: false })
      return
    }
    if (reason === 'visible-pty') {
      if (
        (hasForegroundAgentEvidence || hasKnownAgentEvidence) &&
        processName !== null &&
        isShellProcess(processName)
      ) {
        hasForegroundAgentEvidence = false
        hasKnownAgentEvidence = false
        hasAgentExpectation = false
        deps.publish({ agent: null, shellForeground: true })
        deps.onConfirmedShellForeground?.(reason)
        deps.onVisibleForegroundSettled?.('shell')
      } else {
        deps.onVisibleForegroundSettled?.('inconclusive')
      }
      return
    }
    if (reason === 'command-finished') {
      if (processName === null) {
        // Why: unavailable inspection is not confirmed shell evidence; retire
        // stale routing after the bounded D ladder without asserting shell truth.
        hasForegroundAgentEvidence = false
        hasKnownAgentEvidence = false
        hasAgentExpectation = false
        deps.publish({ agent: null, shellForeground: false })
        deps.onCommandFinishedUnavailable?.()
        return
      }
      if ((hasForegroundAgentEvidence || hasKnownAgentEvidence) && !isShellProcess(processName)) {
        return
      }
      // Why: the 133;D fired AND the foreground shows no agent — together that is
      // real prompt proof, so the agent truly exited. Reset the evidence so the
      // pane's ordinary shell commands go back to the no-RPC finished path.
      hasForegroundAgentEvidence = false
      hasKnownAgentEvidence = false
      hasAgentExpectation = false
      deps.publish({ agent: null, shellForeground: true })
      // Why: confirmed exit — let callers clear a stale agent title the shell
      // won't repaint (a plain `codex`/`grok` leaves its OSC title behind).
      deps.onConfirmedShellForeground?.(reason)
    }
  }

  return {
    onVisiblePtyBound(expectsAgent = false) {
      // Why: command-start and command-finished reads own the exit decision;
      // visibility recovery is lower-authority and must never cancel them.
      if (
        scheduledReadReason === 'command' ||
        activeReadReason === 'command' ||
        scheduledReadReason === 'command-finished' ||
        activeReadReason === 'command-finished'
      ) {
        return false
      }
      cancelPendingRead()
      if (!trackablePtyId()) {
        return false
      }
      if (expectsAgent || deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Why: restored/manual agent panes can become visible while Codex is
      // already foreground, so no OSC 133 command-start event will seed the tab icon.
      scheduleRead(VISIBLE_PTY_SETTLE_MS, 0, 'visible-pty')
      return true
    },
    onCommandStarted(expectedAgent = null) {
      cancelPendingRead()
      if (!trackablePtyId()) {
        return
      }
      const alreadyHasKnownIdentity = deps.hasKnownAgentIdentity?.() === true
      hasAgentExpectation = expectedAgent !== null
      if (alreadyHasKnownIdentity) {
        hasKnownAgentEvidence = true
      }
      // Why: every new command invalidates the previous byte-routing authority.
      // Launch/hook identity remains only an expectation until fresh evidence.
      deps.publish({ agent: null, shellForeground: false })
      scheduleRead(COMMAND_SETTLE_MS, 0, 'command')
    },
    onCommandFinished() {
      if (deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Why: a rapid 133;C→133;D pair cancels the command-start read before it
      // can identify the foreground — that pair is exactly a leaked nested-shell
      // command under a full-screen agent (or a fast real shell command), so on a
      // no-identity pane confirm it rather than trusting the D as a prompt return.
      // ANY in-flight read counts: a command-start read, a prior confirming read
      // (user shell integrations double up Orca's OSC 133), or the reattach/visible
      // recovery probe. All three are attempts to establish this pane's identity, so
      // a D that cancels one must re-confirm — never fast-path to shell, which the
      // sampleVisiblePaneForegroundAgent gate would then latch, permanently hiding
      // an idle reattached agent's icon (the "codex reattached at rest" bug).
      cancelPendingRead()
      if (!trackablePtyId()) {
        return false
      }
      // Why: trust the 133;D and mark shell without an RPC only when nothing hints
      // at an agent — no prior agent evidence, no launch/hook identity, and no
      // identity read racing this finish.
      if (!hasForegroundAgentEvidence && !hasKnownAgentEvidence && !hasAgentExpectation) {
        deps.publish({ agent: null, shellForeground: true })
        return false
      }
      // Why: confirm the foreground before clearing — if the agent still owns it,
      // the read republishes its identity; only a genuine shell result clears it.
      scheduleRead(COMMAND_SETTLE_MS, 0, 'command-finished')
      return true
    },
    dispose() {
      disposed = true
      cancelPendingRead()
    }
  }
}
