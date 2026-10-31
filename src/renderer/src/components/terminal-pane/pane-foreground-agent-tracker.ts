import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../../../shared/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import { createPaneForegroundProcessReader } from './pane-foreground-process-reader'
import { FOREGROUND_COMMAND_READS } from '../../../../shared/foreground-command-settle'
import type {
  ForegroundReadReason,
  PaneForegroundAgentTrackerDeps
} from './pane-foreground-agent-tracker-contract'

const VISIBLE_PTY_SETTLE_MS = 350

/** Read foreground identity at command boundaries; confirm 133;D before clearing known agents because nested shells can leak that marker. */
export function createPaneForegroundAgentTracker(deps: PaneForegroundAgentTrackerDeps): {
  /** True while any read is scheduled or running, whatever its authority. */
  hasReadInFlight: () => boolean
  onVisiblePtyBound: (expectsAgent?: boolean) => boolean
  onCommandStarted: (expectedAgent?: TerminalAgent | null) => void
  onAgentStartupObserved: () => void
  /** True when pane identity must remain visible until an async shell confirmation. */
  onCommandFinished: () => boolean
  /** The process monitor confirmed this agent exited (no agent, no children, settled). */
  onProcessExitConfirmed: (process: RecognizedAgentProcess) => void
  dispose: () => void
} {
  let disposed = false
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledReadReason: ForegroundReadReason | null = null
  let activeReadReason: ForegroundReadReason | null = null
  let readGeneration = 0
  // Nested agent shells leak 133;D onto the main PTY; confirm foreground before treating it as prompt return.
  let hasForegroundAgentEvidence = false
  // Latch launch/hook evidence through confirmation so cleanup cannot disarm the bounded retry ladder.
  let hasKnownAgentEvidence = false
  let hasAgentExpectation = false
  let startupSampled = false
  const readProcess = createPaneForegroundProcessReader(deps)
  const clearAgentEvidence = (): void => {
    hasForegroundAgentEvidence = false
    hasKnownAgentEvidence = false
    hasAgentExpectation = false
  }

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

  const hasPendingRead = (): boolean => scheduledReadReason !== null || activeReadReason !== null
  const hasCommandReadInFlight = (): boolean =>
    scheduledReadReason === 'command' ||
    activeReadReason === 'command' ||
    scheduledReadReason === 'command-finished' ||
    activeReadReason === 'command-finished'

  // Release retained capabilities when a read ends; superseded reads delegate settlement to their successor.
  const releaseRetainedCapability = (hadReadInFlight: boolean): void => {
    if (hadReadInFlight) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  const settleAbortedRead = (generation: number): void => {
    if (!disposed && generation === readGeneration) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  async function readForeground(
    generation: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): Promise<void> {
    const ptyId = trackablePtyId()
    if (disposed || generation !== readGeneration || !ptyId) {
      settleAbortedRead(generation)
      return
    }
    const requiresRoutingConfirmation =
      reason === 'command-finished' ||
      hasForegroundAgentEvidence ||
      hasKnownAgentEvidence ||
      hasAgentExpectation
    const { processName, remoteEvidenceVerdict, expectedIncarnationId, remote } = await readProcess(
      ptyId,
      requiresRoutingConfirmation
    )
    // Fence pending inspection so an old PTY cannot publish identity into its replacement.
    if (
      disposed ||
      generation !== readGeneration ||
      trackablePtyId() !== ptyId ||
      (remote && deps.getExpectedIncarnationId?.() !== expectedIncarnationId)
    ) {
      settleAbortedRead(generation)
      return
    }
    const recognized =
      remoteEvidenceVerdict === 'live'
        ? recognizeAgentProcess(processName)
        : remoteEvidenceVerdict !== null
          ? null
          : recognizeAgentProcess(processName)
    if (recognized) {
      hasForegroundAgentEvidence = true
      hasAgentExpectation = false
      deps.publish({
        agent: recognized.agent,
        agentEvidence: 'process-read',
        shellForeground: false,
        ...(requiresRoutingConfirmation ? { routingTrusted: true } : {})
      })
      // Why: nothing else re-derives this read in a pane without command marks.
      if (!remote) {
        deps.onAgentProcessRead?.(recognized)
      }
      if (reason === 'visible-pty') {
        deps.onVisibleForegroundSettled?.('agent')
      }
      return
    }
    // 133;D cancels pending reads, so a surviving command read’s shell is nested and cannot prove prompt return.
    const retryDelay = FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex]
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
      // Bound retries across PowerShell-to-WMIC enrichment, which may initially hide a live agent.
      scheduleRead(retryDelay, retryIndex + 1, reason)
      return
    }
    if (reason === 'command') {
      if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
        hasAgentExpectation = false
        return
      }
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
        clearAgentEvidence()
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
        if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
          deps.onCommandFinishedUnavailable?.()
          return
        }
        // Unverifiable inspection is not shell proof; retire stale routing after the bounded D ladder without asserting shell truth.
        clearAgentEvidence()
        deps.publish({ agent: null, shellForeground: false })
        deps.onCommandFinishedUnavailable?.()
        return
      }
      if ((hasForegroundAgentEvidence || hasKnownAgentEvidence) && !isShellProcess(processName)) {
        // Settle any visible confirmation this read replaced, or its retained capability has no remaining owner to release it.
        deps.onVisibleForegroundSettled?.('inconclusive')
        return
      }
      // 133;D plus no foreground agent proves exit; reset evidence to restore ordinary commands’ no-RPC finish path.
      clearAgentEvidence()
      deps.publish({ agent: null, shellForeground: true })
      // Clear stale agent titles that the shell does not repaint.
      deps.onConfirmedShellForeground?.(reason)
    }
  }

  return {
    // A higher-authority command read still promises confirmation when visibility schedules nothing.
    hasReadInFlight(): boolean {
      return hasPendingRead()
    },
    onVisiblePtyBound(expectsAgent = false) {
      // Lower-authority visibility recovery must not cancel command-boundary reads that own the exit decision.
      if (hasCommandReadInFlight()) {
        return false
      }
      const hadReadBeforeVisibleBind = hasPendingRead()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeVisibleBind)
        return false
      }
      if (expectsAgent || deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Restore/manual panes may already run an agent without a command-start event to seed identity.
      scheduleRead(VISIBLE_PTY_SETTLE_MS, 0, 'visible-pty')
      return true
    },
    onCommandStarted(expectedAgent = null) {
      startupSampled = false
      const hadReadBeforeCommandStart = hasPendingRead()
      cancelPendingRead()
      const ptyId = trackablePtyId()
      if (!ptyId) {
        releaseRetainedCapability(hadReadBeforeCommandStart)
        return
      }
      const alreadyHasKnownIdentity = deps.hasKnownAgentIdentity?.() === true
      hasAgentExpectation = expectedAgent !== null
      if (alreadyHasKnownIdentity) {
        hasKnownAgentEvidence = true
      }
      // New commands invalidate routing authority; launch/hook expectations and remote markers supply no identity before fresh host evidence.
      if (deps.isRemotePtyId?.(ptyId) !== true) {
        deps.publish({ agent: null, shellForeground: false })
      }
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command')
    },
    onAgentStartupObserved() {
      if (
        disposed ||
        startupSampled ||
        hasForegroundAgentEvidence ||
        hasPendingRead() ||
        !trackablePtyId()
      ) {
        return
      }
      // A late startup title requests one bounded confirmation; it never supplies identity.
      startupSampled = true
      cancelPendingRead()
      hasAgentExpectation = true
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command')
    },
    onCommandFinished() {
      startupSampled = false
      if (deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Any identity read cancelled by rapid 133;C→D needs reconfirmation; trusting D could latch shell state and permanently hide a reattached agent.
      const hadReadBeforeCommandFinish = hasPendingRead()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeCommandFinish)
        return false
      }
      const ptyId = trackablePtyId()!
      // Trust D without an RPC only with no prior agent evidence, launch/hook identity or racing identity read.
      if (!hasForegroundAgentEvidence && !hasKnownAgentEvidence && !hasAgentExpectation) {
        if (deps.isRemotePtyId?.(ptyId) !== true) {
          deps.publish({ agent: null, shellForeground: true })
        }
        return false
      }
      // Confirm before clearing: a live agent republishes identity; a genuine shell result clears it.
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command-finished')
      return true
    },
    onProcessExitConfirmed(process) {
      // Why: an in-flight command read owns the pane's next identity, and only a live read is ours.
      const published = deps.getPublishedEntry?.()
      if (
        disposed ||
        hasCommandReadInFlight() ||
        published?.agentEvidence !== 'process-read' ||
        resolveCompatibleAgentTypeForOwner(process.agent, published.agent) !== published.agent
      ) {
        return
      }
      const hadVisibleRead = hasPendingRead()
      cancelPendingRead()
      clearAgentEvidence()
      startupSampled = false
      // Without command marks, shellForeground would never lift and would block Enter from identifying the next agent.
      deps.publish({ agent: null, shellForeground: false })
      if (hadVisibleRead) {
        deps.onVisibleForegroundSettled?.('shell')
      }
      deps.onConfirmedShellForeground?.('process-exit')
    },
    dispose() {
      const hadReadAtDispose = hasPendingRead()
      disposed = true
      cancelPendingRead()
      releaseRetainedCapability(hadReadAtDispose)
    }
  }
}
