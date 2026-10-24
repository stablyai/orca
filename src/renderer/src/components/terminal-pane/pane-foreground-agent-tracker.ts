import { createPaneForegroundObservationTransitions } from './pane-foreground-observation-transitions'
import { notifyPaneStartupStateChanged } from '@/lib/pane-spawn-deferral-registry'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { createPaneForegroundProcessReader } from './pane-foreground-process-reader'
import { FOREGROUND_COMMAND_READS } from '../../../../shared/foreground-command-settle'
import {
  isObservationOwnerSuperseded,
  type ForegroundReadReason,
  type PaneForegroundAgentTracker,
  type PaneForegroundAgentTrackerDeps
} from './pane-foreground-agent-tracker-contract'

const VISIBLE_PTY_SETTLE_MS = 350

/**
 * Publishes process-table identity for a pane at OSC 133 command boundaries:
 * one foreground read when a command starts (that is when the foreground
 * changes), and a shell-foreground mark when it finishes. A 133;D is normally
 * the shell-foreground proof; for a pane an agent has owned it is confirmed by a
 * foreground read first, because a full-screen agent's nested command shells
 * leak their own 133;D onto the main PTY.
 */
export function createPaneForegroundAgentTracker(
  deps: PaneForegroundAgentTrackerDeps
): PaneForegroundAgentTracker {
  let disposed = false
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledReadReason: ForegroundReadReason | null = null
  let activeReadReason: ForegroundReadReason | null = null
  let readGeneration = 0
  // Why: a full-screen agent (Codex, etc.) runs nested command shells whose own
  // OSC 133;D leaks onto the main PTY. For a pane an agent has owned, that D is
  // not proof the prompt returned, so confirm the foreground before clearing.
  let hasForegroundAgentEvidence = false
  // D ends presentation history; the process monitor owns lifetime independently.
  let hasKnownAgentEvidence = false
  let hasAgentExpectation = false
  let startupSampled = false
  const readProcess = createPaneForegroundProcessReader(deps)
  const markForegroundAgentEvidence = (): void => {
    hasForegroundAgentEvidence = true
    hasAgentExpectation = false
  }
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
    notifyPaneStartupStateChanged()
  }

  const scheduleRead = (
    delayMs: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): void => {
    const generation = readGeneration
    scheduledReadReason = reason
    notifyPaneStartupStateChanged()
    readTimer = setTimeout(() => {
      readTimer = null
      scheduledReadReason = null
      activeReadReason = reason
      void readForeground(generation, retryIndex, reason).finally(() => {
        if (generation === readGeneration && activeReadReason === reason) {
          activeReadReason = null
          notifyPaneStartupStateChanged()
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

  // Why: the store entry outlives this tracker, so any capability a caller retained
  // pending a read must be released by whichever exit ends that read. A superseded
  // read is the one exception — its successor settles for it.
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
    const ownerAtRequest = deps.getObservationOwner?.()
    const { processName, remoteEvidenceVerdict, expectedIncarnationId, remote } = await readProcess(
      ptyId,
      requiresRoutingConfirmation
    )
    // Why: a pane key can be rebound while process inspection is pending; the
    // old PTY's identity must never publish into its replacement session.
    if (
      disposed ||
      generation !== readGeneration ||
      trackablePtyId() !== ptyId ||
      isObservationOwnerSuperseded(ownerAtRequest, deps.getObservationOwner?.()) ||
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
      markForegroundAgentEvidence()
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
    // Why: a shell seen here is NOT prompt proof — 133;D cancels pending reads,
    // so a still-live generation means the command is running and the shell is
    // a nested one (sh/bash without integration); marking shell-foreground
    // would suppress live title identity. Only 133;D proves the prompt.
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
      // Why: provisional PowerShell may hide a live agent; the bounded ladder
      // spans PowerShell-to-WMIC enrichment without becoming a polling loop.
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
        releaseForeground(reason)
        deps.onVisibleForegroundSettled?.('shell')
      } else {
        deps.onVisibleForegroundSettled?.('inconclusive')
      }
      return
    }
    if (reason === 'command-finished') {
      if (processName === null) {
        deps.onCommandFinishedUnavailable?.()
        return
      }
      if (!isShellProcess(processName)) {
        // Why: this read may have replaced a cancelled visible-pty confirmation.
        // It publishes nothing, so without settling here the capability it was
        // asked to revalidate would be retained with no read left to clear it.
        deps.onVisibleForegroundSettled?.('inconclusive')
        return
      }
      releaseForeground(reason)
    }
  }

  function releaseForeground(reason: 'visible-pty' | 'command-finished' | 'process-exit'): void {
    const accepted = deps.onConfirmedShellForeground?.(reason)
    if (accepted !== false && reason === 'command-finished') {
      if (accepted === true && (hasForegroundAgentEvidence || hasKnownAgentEvidence)) {
        deps.onConfirmedShellForeground?.('visible-pty')
      }
      clearAgentEvidence()
      startupSampled = false
      cancelPendingRead()
    }
    if (accepted !== undefined) {
      return
    }
    cancelPendingRead()
    // Foreground release preserves the monitor's lifetime identity through job control.
    deps.publish({ agent: null, shellForeground: true })
  }

  return {
    // Why: onVisiblePtyBound refuses to schedule while a higher-authority
    // command read owns the pane, so "it scheduled nothing" must not be read
    // as "nothing will confirm this pane".
    hasReadInFlight(): boolean {
      return hasPendingRead()
    },
    onVisiblePtyBound(expectsAgent = false) {
      // Why: command-start and command-finished reads own the exit decision;
      // visibility recovery is lower-authority and must never cancel them.
      if (hasCommandReadInFlight()) {
        return false
      }
      const hadReadBeforeVisibleBind = hasPendingRead()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeVisibleBind)
        return false
      }
      hasAgentExpectation ||= expectsAgent || deps.hasAgentExpectation?.() === true
      hasKnownAgentEvidence ||= deps.hasKnownAgentIdentity?.() === true
      // Why: restored/manual agent panes can become visible while Codex is
      // already foreground, so no OSC 133 command-start event will seed the tab icon.
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
      hasAgentExpectation = expectedAgent !== null || deps.hasAgentExpectation?.() === true
      if (alreadyHasKnownIdentity) {
        hasKnownAgentEvidence = true
      }
      // Why: every new command invalidates the previous byte-routing authority.
      // Launch/hook identity remains only an expectation until fresh evidence.
      // Remote marker bytes are turn boundaries only; do not mutate a remote
      // identity from an OSC stream before the host evidence read completes.
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
      hasAgentExpectation ||= deps.hasAgentExpectation?.() === true
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
      const hadReadBeforeCommandFinish = hasPendingRead()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeCommandFinish)
        return false
      }
      const ptyId = trackablePtyId()!
      // Why: trust the 133;D and mark shell without an RPC only when nothing hints
      // at an agent — no prior agent evidence, no launch/hook identity, and no
      // identity read racing this finish.
      if (!hasForegroundAgentEvidence && !hasKnownAgentEvidence && !hasAgentExpectation) {
        if (deps.isRemotePtyId?.(ptyId) !== true) {
          deps.publish({ agent: null, shellForeground: true })
        }
        return false
      }
      // Why: confirm the foreground before clearing — if the agent still owns it,
      // the read republishes its identity; only a genuine shell result clears it.
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command-finished')
      return true
    },
    ...createPaneForegroundObservationTransitions({
      deps,
      disposed: () => disposed,
      hasCommandReadInFlight,
      cancelPendingRead,
      markForegroundAgentEvidence,
      clearAgentEvidence,
      resetStartup: () => {
        startupSampled = false
      }
    }),
    dispose() {
      const hadReadAtDispose = hasPendingRead()
      disposed = true
      cancelPendingRead()
      releaseRetainedCapability(hadReadAtDispose)
    }
  }
}
