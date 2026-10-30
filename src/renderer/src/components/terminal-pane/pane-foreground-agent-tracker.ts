import {
  createPaneForegroundProcessReader,
  foregroundResultRetryDelay,
  createForegroundProcessExitHandler
} from './pane-foreground-process-reader'
import { FOREGROUND_COMMAND_READS } from '../../../../shared/foreground-command-settle'
import type {
  ForegroundReadReason,
  PaneForegroundAgentTracker,
  PaneForegroundAgentTrackerDeps
} from './pane-foreground-agent-tracker-contract'

const VISIBLE_PTY_SETTLE_MS = 350

/** Read actual process identity at command boundaries under the existing bounded iteration. */
export function createPaneForegroundAgentTracker(
  deps: PaneForegroundAgentTrackerDeps
): PaneForegroundAgentTracker {
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

  const settleAbortedRead = (generation: number): void =>
    releaseRetainedCapability(!disposed && generation === readGeneration)

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
    const readIsCurrent = deps.captureRead?.()
    const inspection = await readProcess(ptyId, requiresRoutingConfirmation)
    const { processName, remoteEvidenceVerdict, remote, recognized, shellProcess } = inspection
    // Fence pending inspection so an old PTY cannot publish identity into its replacement.
    if (
      disposed ||
      generation !== readGeneration ||
      trackablePtyId() !== ptyId ||
      (remote && deps.getExpectedIncarnationId?.() !== inspection.expectedIncarnationId)
    ) {
      settleAbortedRead(generation)
      return
    }
    if (readIsCurrent?.() === false) {
      const retryDelay = FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex]
      if (retryDelay !== undefined && trackablePtyId()) {
        scheduleRead(retryDelay, retryIndex + 1, reason)
      } else {
        deps.onVisibleForegroundSettled?.('inconclusive')
      }
      return
    }
    if (recognized) {
      hasForegroundAgentEvidence = true
      hasAgentExpectation = false
      deps.publish({
        agent: recognized.agent,
        agentEvidence: 'process-read',
        observationGeneration: generation,
        shellForeground: false,
        ...(requiresRoutingConfirmation ? { routingTrusted: true } : {})
      })
      // Why: nothing else re-derives this read in a pane without command marks.
      if (!remote) {
        deps.onAgentProcessRead?.(recognized)
      }
      deps.onVisibleForegroundSettled?.('agent')
      return
    }
    // 133;D cancels pending reads, so a surviving command read’s shell is nested and cannot prove prompt return.
    const retryDelay = foregroundResultRetryDelay(
      hasForegroundAgentEvidence || hasKnownAgentEvidence || hasAgentExpectation,
      reason,
      processName,
      inspection.wrapperProcess,
      retryIndex
    )
    if (retryDelay !== undefined) {
      // Bound retries across PowerShell-to-WMIC enrichment, which may initially hide a live agent.
      scheduleRead(retryDelay, retryIndex + 1, reason)
      return
    }
    if (reason === 'command') {
      if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
        hasAgentExpectation = false
        deps.demote?.()
        deps.onVisibleForegroundSettled?.('inconclusive')
        return
      }
      hasAgentExpectation = false
      if (!deps.demote || !deps.getPublishedEntry?.()?.agent) {
        deps.publish({ agent: null, shellForeground: false })
      }
      deps.onVisibleForegroundSettled?.('inconclusive')
      return
    }
    if (reason === 'visible-pty') {
      if (
        (hasForegroundAgentEvidence || hasKnownAgentEvidence) &&
        processName !== null &&
        shellProcess
      ) {
        clearAgentEvidence()
        deps.publish({ agent: null, shellForeground: true })
        deps.onConfirmedShellForeground?.(reason)
        deps.onVisibleForegroundSettled?.('shell')
      } else {
        deps.demote?.()
        deps.onVisibleForegroundSettled?.('inconclusive')
      }
      return
    }
    if (reason === 'command-finished') {
      if (processName === null) {
        if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
          deps.demote?.()
          deps.onVisibleForegroundSettled?.('inconclusive')
          deps.onCommandFinishedUnavailable?.()
          return
        }
        // Unverifiable inspection is not shell proof; retire stale routing after the bounded D ladder without asserting shell truth.
        clearAgentEvidence()
        if (!deps.demote || !deps.getPublishedEntry?.()?.agent) {
          deps.publish({ agent: null, shellForeground: false })
        }
        deps.onVisibleForegroundSettled?.('inconclusive')
        deps.onCommandFinishedUnavailable?.()
        return
      }
      if ((hasForegroundAgentEvidence || hasKnownAgentEvidence) && !shellProcess) {
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
      hasAgentExpectation = hasAgentExpectation || expectedAgent !== null
      hasKnownAgentEvidence ||= deps.hasKnownAgentIdentity?.() === true
      // New commands invalidate routing authority; launch/hook expectations and remote markers supply no identity before fresh host evidence.
      if (!deps.demote?.() && deps.isRemotePtyId?.(ptyId) !== true) {
        deps.publish({ agent: null, shellForeground: false })
      }
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command')
    },
    onAcceptedInputBoundary() {
      if (disposed || !trackablePtyId()) {
        return
      }
      // Join the current bounded iteration; repeated input must not postpone its next read.
      hasAgentExpectation = true
      deps.demote?.()
      if (hasPendingRead()) {
        return
      }
      startupSampled = false
      cancelPendingRead()
      hasKnownAgentEvidence ||= deps.hasKnownAgentIdentity?.() === true
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
      hasKnownAgentEvidence ||= deps.hasKnownAgentIdentity?.() === true
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
      deps.demote?.()
      // Confirm before clearing: a live agent republishes identity; a genuine shell result clears it.
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command-finished')
      return true
    },
    onProcessExitConfirmed: createForegroundProcessExitHandler(deps, {
      isCurrent: () => !disposed && !hasCommandReadInFlight(),
      hasPendingRead,
      reset: () => {
        cancelPendingRead()
        clearAgentEvidence()
        startupSampled = false
      }
    }),
    suspend() {
      const hadRead = hasPendingRead()
      cancelPendingRead()
      deps.demote?.()
      releaseRetainedCapability(hadRead)
    },
    dispose() {
      const hadReadAtDispose = hasPendingRead()
      disposed = true
      cancelPendingRead()
      releaseRetainedCapability(hadReadAtDispose)
    }
  }
}
