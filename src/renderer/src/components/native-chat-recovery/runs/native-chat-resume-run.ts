import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import type { RestartContinuationOutcome } from './native-chat-restart-continuation-outcomes'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'

export type ResumeRunHostStatus = Pick<
  AgentSessionStatusSummary,
  'restartResume' | 'hostExecutionPhase'
>

/** Who started a run: this launch's "resume automatically" preference, or the user's own click. */
export type ResumeRunStarter = 'launch' | 'user'

/** Selection and history belong to this window; live progress and failures belong to the host. */
export type ResumeRun = Readonly<{
  startedAt: number
  startedBy: ResumeRunStarter
  entries: readonly Readonly<{ candidate: ResumeCandidate; observedStatus?: ResumeRunHostStatus }>[]
  inFlight: boolean
  continued?: readonly RestartContinuationOutcome[]
  finishedViewShown?: boolean
  /** While a retry is in flight: chats earlier runs resumed that it does not retry. Settling folds
   *  them back into entries, so a settled run reads like any other. */
  resumedBefore?: readonly ResumeCandidate[]
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

/** Clearing live fields cannot undo progress this action already showed. `indices` limits the check to entries an update touched. */
export function observeResumeRun(
  run: ResumeRun,
  statusFor: (sessionId: string) => ResumeRunHostStatus | undefined,
  indices: Iterable<number> = run.entries.keys()
): ResumeRun {
  if (!run.inFlight) {
    return run
  }
  let entries: ResumeRun['entries'][number][] | null = null
  for (const index of indices) {
    const entry = run.entries[index]
    const status = entry && statusFor(entry.candidate.sessionId)
    if (!entry || progressRank(status) <= progressRank(entry.observedStatus)) {
      continue
    }
    entries ??= [...run.entries]
    entries[index] = {
      ...entry,
      observedStatus: {
        restartResume: status?.restartResume,
        hostExecutionPhase: status?.hostExecutionPhase
      }
    }
  }
  return entries ? { ...run, entries } : run
}

export function resumeRunInFlight(run: ResumeRun | null): boolean {
  return run?.inFlight ?? false
}

export function isResumeRunPendingPhase(
  phase: NonNullable<ResumeRunHostStatus['restartResume']>['phase'] | undefined
): boolean {
  return phase === undefined || phase === 'queued' || phase === 'starting'
}

export function isResumeRunSessionStarting(run: ResumeRun | null, sessionId: string): boolean {
  if (!run?.inFlight) {
    return false
  }
  const entry = run.entries.find(({ candidate }) => candidate.sessionId === sessionId)
  return (
    entry !== undefined &&
    entry.candidate.surface !== 'terminal' &&
    isResumeRunPendingPhase(entry.observedStatus?.restartResume?.phase)
  )
}

export function beginResumeRun(
  candidates: readonly ResumeCandidate[],
  now: number,
  startedBy: ResumeRunStarter
): ResumeRun {
  return {
    startedAt: now,
    startedBy,
    entries: candidates.map((candidate) => ({ candidate })),
    inFlight: true
  }
}

/** A retry replaces the run; what earlier runs already resumed stays reported unless retried. */
export function nextResumeRun(
  previous: ResumeRun | null,
  candidates: readonly ResumeCandidate[],
  now: number,
  startedBy: ResumeRunStarter
): ResumeRun {
  const next = beginResumeRun(candidates, now, startedBy)
  if (!previous) {
    return next
  }
  const retried = new Set(candidates.map((candidate) => candidate.sessionId))
  const continued = new Set(
    previous.inFlight
      ? []
      : previous.continued
          ?.filter((entry) => entry.outcome === 'continued')
          .map((entry) => entry.sessionId)
  )
  const carried = new Map<string, ResumeCandidate>()
  for (const candidate of [
    ...(previous.resumedBefore ?? []),
    ...previous.entries
      .map((entry) => entry.candidate)
      .filter((candidate) => continued.has(candidate.sessionId))
  ]) {
    if (!retried.has(candidate.sessionId)) {
      carried.set(candidate.sessionId, candidate)
    }
  }
  return carried.size > 0 ? { ...next, resumedBefore: [...carried.values()] } : next
}

/** One action owns the occurrence: while it is in flight nothing else is sent, even a repeat. */
export function unsentResumeIds(
  run: ResumeRun | null,
  sessionIds: readonly string[]
): readonly string[] {
  return run?.inFlight ? [] : [...new Set(sessionIds)]
}

/** The action's reply: what it skipped leaves the run, and earlier successes rejoin it. */
export function settledResumeRun(
  run: ResumeRun,
  attempted: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
  continued: readonly RestartContinuationOutcome[]
): ResumeRun {
  const { resumedBefore = [], ...rest } = run
  return {
    ...rest,
    entries: [
      ...resumedBefore.map((candidate) => ({ candidate })),
      ...run.entries.filter(
        (entry) =>
          attempted.has(entry.candidate.sessionId) && !skipped.has(entry.candidate.sessionId)
      )
    ],
    inFlight: false,
    continued: [
      ...resumedBefore.map((candidate) => ({
        sessionId: candidate.sessionId,
        outcome: 'continued' as const
      })),
      ...continued
    ]
  }
}

const NONE: readonly string[] = []
/** Keep the selection protected until the action's authoritative reply has been published. */
export function resumeRunPendingIds(run: ResumeRun | null): readonly string[] {
  return run?.inFlight ? run.entries.map((entry) => entry.candidate.sessionId) : NONE
}

/** Drops dismissed chats from a settled run; no ids means every chat was dismissed. */
export function withoutResumeRunSessions(
  run: ResumeRun,
  sessionIds: readonly string[] | undefined
): ResumeRun | null {
  if (sessionIds === undefined) {
    return null
  }
  const dismissed = new Set(sessionIds)
  const entries = run.entries.filter((entry) => !dismissed.has(entry.candidate.sessionId))
  if (entries.length === 0) {
    return null
  }
  return {
    ...run,
    entries,
    continued: run.continued?.filter((entry) => !dismissed.has(entry.sessionId))
  }
}
