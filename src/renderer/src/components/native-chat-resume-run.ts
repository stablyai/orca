import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import type { RestartContinuationOutcome } from './native-chat-restart-action-notifications'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

export type ResumeRunHostStatus = Pick<
  AgentSessionStatusSummary,
  'restartResume' | 'hostExecutionPhase'
>

/** Selection and history belong to this window; live progress and failures belong to the host. */
export type ResumeRun = Readonly<{
  startedAt: number
  entries: readonly Readonly<{ candidate: ResumeCandidate; observedStatus?: ResumeRunHostStatus }>[]
  inFlight: boolean
  continued?: readonly RestartContinuationOutcome[]
  finishedViewShown?: boolean
}>

function progressRank(status: ResumeRunHostStatus | undefined): number {
  const phase = status?.restartResume?.phase
  if (phase === 'starting') {
    return status?.hostExecutionPhase === 'ready' ? 4 : 3
  }
  if (phase === 'queued') {
    return 2
  }
  if (phase === 'skipped') {
    return 1
  }
  return phase === 'continued' || phase === 'refused' || phase === 'unconfirmed' ? 5 : 0
}

/** Clearing live fields cannot undo progress this action already showed. */
export function observeResumeRun(
  run: ResumeRun,
  statusFor: (sessionId: string) => ResumeRunHostStatus | undefined
): ResumeRun {
  if (!run.inFlight) {
    return run
  }
  let changed = false
  const entries = run.entries.map((entry) => {
    const status = statusFor(entry.candidate.sessionId)
    if (progressRank(status) <= progressRank(entry.observedStatus)) {
      return entry
    }
    changed = true
    return {
      ...entry,
      observedStatus: {
        restartResume: status?.restartResume,
        hostExecutionPhase: status?.hostExecutionPhase
      }
    }
  })
  return changed ? { ...run, entries } : run
}

export function resumeRunInFlight(run: ResumeRun | null): boolean {
  return run?.inFlight ?? false
}

export function beginResumeRun(candidates: readonly ResumeCandidate[], now: number): ResumeRun {
  return { startedAt: now, entries: candidates.map((candidate) => ({ candidate })), inFlight: true }
}

const NONE: readonly string[] = []
/** Keep the selection protected until the action's authoritative reply has been published. */
export function resumeRunPendingIds(run: ResumeRun | null): readonly string[] {
  return run?.inFlight ? run.entries.map((entry) => entry.candidate.sessionId) : NONE
}
