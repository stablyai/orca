import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type { InspectionPriority } from './process-inspection/agent-process-inspection-queue'
import type { PendingTitleController } from './agent-completion-pending-title'
import type { ProcessMonitorState } from './agent-completion-process-types'
import {
  NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS,
  POLL_TIER_INTERVAL_MS,
  type PollCadenceTier
} from './agent-completion-poll-cadence'
import { nextCadenceInspectionDelayMs } from './agent-completion-poll-interval'
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../../../../shared/process-observation/tables/process-table-snapshot'

/** Inconclusive reads (children, a discarded read) retry this many times per event, then wait for the next event. */
const MAX_UNRESOLVED_FOLLOW_UPS = 3

/** 'error' retries with backoff until a read succeeds; 'unresolved' is capped per event. */
export type CadenceFollowUp = 'pending' | 'unresolved' | 'error'

/** Reads are event-driven: output, input echo, title, hook or a new PTY bind arm one trailing read. A
 * quiet pane arms no timer, because an agent's exit always redraws the shell prompt or ends the PTY. */
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

  function isPaneQuiet(now: number): boolean {
    return (
      state.lastPaneActivityAt === null ||
      now - state.lastPaneActivityAt >= NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS
    )
  }

  function currentPollTier(): PollCadenceTier {
    const ptyId = options.getPtyId()
    if (ptyId && options.isRemotePtyId?.(ptyId) === true) {
      return 'hidden'
    }
    const now = Date.now()
    // A quiet pane reads only to retry an inconclusive read; a pending exit still confirms fast.
    if (
      (state.lastForegroundAgent || state.hasAgentRunEvidence) &&
      state.pendingProcessExit === null &&
      isPaneQuiet(now)
    ) {
      return 'quiet-agent'
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
    if (options.isProcessInspectionCostly?.() === true && isPaneQuiet(now)) {
      return 'no-evidence'
    }
    return 'idle'
  }

  function onPollTimer(tier: PollCadenceTier): void {
    state.pollTimer = null
    state.pollTimerTier = null
    const now = Date.now()
    const dueSince = state.readDueSince
    const settleMs = POLL_TIER_INTERVAL_MS[tier]
    // Throttle at the tier interval, waiting at most one snapshot TTL more so the read postdates the latest output.
    if (dueSince !== null && state.lastPaneActivityAt !== null) {
      const throttleAt = dueSince + settleMs
      const freshAt = Math.min(
        state.lastPaneActivityAt + PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS,
        throttleAt + PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
      )
      const remaining = Math.max(throttleAt, freshAt) - now
      if (remaining > 0) {
        armPollTimer(tier, remaining)
        return
      }
    }
    requestInspection('cadence')
  }

  function armPollTimer(tier: PollCadenceTier, delayMs: number): void {
    state.pollTimerTier = tier
    state.pollTimer = setTimeout(() => onPollTimer(tier), delayMs)
  }

  function scheduleNextPoll(): void {
    if (state.disposed || !state.pollTrackingStarted || !options.isLive() || pendingTitle.get()) {
      return
    }
    if (state.readDueSince === null) {
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
    const now = Date.now()
    // Align only genuinely idle panes; agent activity retains the exact interval and phase.
    const isIdlePane =
      tier === 'quiet-agent' || (state.lastForegroundAgent === null && isPaneQuiet(now))
    armPollTimer(
      tier,
      nextCadenceInspectionDelayMs({
        baseMs: backoff,
        hasConsecutiveErrors: state.consecutiveInspectionErrors > 0,
        alignToSharedGrid: isIdlePane,
        now
      })
    )
  }

  /** Something that can change the foreground happened; read once after it settles. */
  function noteForegroundEvent(at = Date.now()): void {
    state.readDueSince ??= at
    state.unresolvedFollowUps = 0
    scheduleNextPoll()
  }

  /** A read left a bounded question open: an exit to confirm, a hook done in flight, a failed or inconclusive read. */
  function requestFollowUp(kind: CadenceFollowUp): void {
    if (kind === 'unresolved') {
      if (state.unresolvedFollowUps >= MAX_UNRESOLVED_FOLLOW_UPS) {
        return
      }
      state.unresolvedFollowUps += 1
    }
    state.readDueSince ??= Date.now()
    scheduleNextPoll()
  }

  /** The read now starting answers every event before it, except output too recent for a shared snapshot to show. */
  function consumeReadDue(): void {
    const lastActivity = state.lastPaneActivityAt
    state.readDueSince =
      lastActivity !== null && lastActivity > Date.now() - PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
        ? lastActivity
        : null
  }

  return {
    clearPollTimer,
    scheduleNextPoll,
    shouldRunCadenceInspection,
    noteForegroundEvent,
    requestFollowUp,
    consumeReadDue
  }
}
