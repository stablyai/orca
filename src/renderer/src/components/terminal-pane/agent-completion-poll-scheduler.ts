import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type { InspectionPriority } from './agent-process-inspection-queue'
import type { PendingTitleController } from './agent-completion-pending-title'
import type { ProcessMonitorState } from './agent-completion-process-types'
import {
  NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS,
  POLL_TIER_INTERVAL_MS,
  type PollCadenceTier
} from './agent-completion-poll-cadence'

export function createAgentCompletionPollScheduler(args: {
  options: AgentCompletionCoordinatorOptions
  state: ProcessMonitorState
  pendingTitle: PendingTitleController
  requestInspection: (priority: InspectionPriority) => void
}) {
  const { options, state, pendingTitle, requestInspection } = args

  function clearPollTimer(): void {
    if (state.pollTimer === null) {
      return
    }
    clearTimeout(state.pollTimer)
    state.pollTimer = null
    state.pollTimerTier = null
  }

  function shouldRunCadenceInspection(): boolean {
    const ptyId = options.getPtyId()
    if (ptyId && options.isRemotePtyId?.(ptyId) === true) {
      return false
    }
    return (
      state.hasAgentRunEvidence ||
      state.lastForegroundAgent !== null ||
      (options.shouldPollProcessCadence?.() !== false &&
        options.shouldPollNoEvidenceProcessCadence?.() !== false) ||
      (options.shouldPollProcessCadence?.() !== false &&
        state.lastPaneActivityAt !== null &&
        Date.now() - state.lastPaneActivityAt < NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS)
    )
  }

  function currentPollTier(): PollCadenceTier {
    const ptyId = options.getPtyId()
    if (ptyId && options.isRemotePtyId?.(ptyId) === true) {
      return 'hidden'
    }
    if (options.shouldPollProcessCadence?.() === false) {
      return 'hidden'
    }
    if (state.lastForegroundAgent) {
      return 'active'
    }
    if (state.hasAgentRunEvidence) {
      return 'idle'
    }
    if (
      options.isProcessInspectionCostly?.() === true &&
      (state.lastPaneActivityAt === null ||
        Date.now() - state.lastPaneActivityAt >= NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS)
    ) {
      return 'no-evidence'
    }
    return 'idle'
  }

  function scheduleNextPoll(): void {
    if (state.disposed || !state.pollTrackingStarted || !options.isLive() || pendingTitle.get()) {
      return
    }
    const tier = currentPollTier()
    if (state.pollTimer !== null) {
      if (
        state.pollTimerTier !== null &&
        POLL_TIER_INTERVAL_MS[tier] < POLL_TIER_INTERVAL_MS[state.pollTimerTier]
      ) {
        clearPollTimer()
      } else {
        return
      }
    }
    if (!shouldRunCadenceInspection() || !options.getPtyId()) {
      return
    }
    const base = POLL_TIER_INTERVAL_MS[tier]
    const backoff =
      state.consecutiveInspectionErrors > 0
        ? Math.min(Math.max(10_000, base), base * 2 ** state.consecutiveInspectionErrors)
        : base
    const interval = Math.round(backoff * (1 + (Math.random() * 0.2 - 0.1)))
    state.pollTimerTier = tier
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null
      state.pollTimerTier = null
      requestInspection('cadence')
    }, interval)
  }

  return { clearPollTimer, scheduleNextPoll, shouldRunCadenceInspection }
}
