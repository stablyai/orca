import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import {
  resumeFailureGuidance,
  resumeFailureSelectable
} from '../failures/native-chat-resume-failure-guidance'
import type { ResumeRun, ResumeRunStarter } from '../runs/native-chat-resume-run'
import { resumeRunView } from '../runs/native-chat-resume-run-view'

export type ResumeToastRowState = 'stopped' | 'resuming' | 'resumed' | 'needs-you'

export type ResumeToastRow = Readonly<{
  candidate: ResumeCandidate
  state: ResumeToastRowState
  failure?: ResumeFailure
  /** The host refused it without filing a failure: nothing to retry or dismiss, only to open. */
  openOnly?: true
}>

export type ResumeToastView = Readonly<{
  /** offer: nothing sent yet; resuming: an action is in flight; finished: its reply settled. */
  phase: 'offer' | 'resuming' | 'finished'
  rows: readonly ResumeToastRow[]
  counts: Readonly<{ resumed: number; resuming: number; needsYou: number; total: number }>
  /** What the toast's one Resume button sends: every chat a retry could still help. */
  resumable: readonly string[]
  interruptedByUpdate: boolean
  startedBy: ResumeRunStarter | null
}>

const ORDER: Record<ResumeToastRowState, number> = {
  'needs-you': 0,
  resuming: 1,
  stopped: 2,
  resumed: 3
}

/** A failure a retry cannot fix stays out of Resume; resuming it would only fail again. */
function resumableByDefault(failure: ResumeFailure | undefined): boolean {
  if (!failure) {
    return true
  }
  if (!resumeFailureSelectable(failure)) {
    return false
  }
  const guidance = resumeFailureGuidance(failure)
  return guidance.primary === 'retry' || guidance.secondary === 'retry'
}

/** "Resumed" only for a chat the host confirmed continued; anything unproven needs the person. */
export function resumeToastView(
  run: ResumeRun | null,
  candidates: readonly ResumeCandidate[],
  failureBySession: ReadonlyMap<string, ResumeFailure>
): ResumeToastView {
  const listed = [...candidates, ...[...failureBySession.values()].filter(notIn(candidates))]
  const failureFor = (sessionId: string) => failureBySession.get(sessionId)
  const view = run ? resumeRunView(run, listed, failureFor, 'all') : null
  const phase = run === null ? 'offer' : run.inFlight ? 'resuming' : 'finished'
  const rows = (view?.rows ?? listed).map((candidate): ResumeToastRow => {
    const failure = failureFor(candidate.sessionId)
    const status = view?.statusBySession.get(candidate.sessionId)
    const state: ResumeToastRowState =
      status?.kind === 'resumed'
        ? 'resumed'
        : status?.kind === 'in-flight'
          ? 'resuming'
          : failure || status || phase === 'finished'
            ? 'needs-you'
            : 'stopped'
    return failure ? { candidate, state, failure } : { candidate, state }
  })
  // One pass over the run, so a large settled run stays linear.
  const refused = refusedWithoutRecord(run)
  if (refused.size > 0) {
    const shown = new Set(rows.map((row) => row.candidate.sessionId))
    for (const { candidate } of run?.entries ?? []) {
      if (refused.has(candidate.sessionId) && !shown.has(candidate.sessionId)) {
        shown.add(candidate.sessionId)
        rows.push({ candidate, state: 'needs-you', openOnly: true })
      }
    }
  }
  rows.sort((a, b) => ORDER[a.state] - ORDER[b.state])
  const count = (state: ResumeToastRowState) => rows.filter((row) => row.state === state).length
  const needsYou = count('needs-you')
  return {
    phase,
    rows,
    counts: {
      resumed: count('resumed'),
      resuming: count('resuming'),
      needsYou,
      total: rows.length
    },
    resumable: rows
      .filter(
        (row) =>
          (row.state === 'stopped' || row.state === 'needs-you') &&
          !row.openOnly &&
          resumableByDefault(row.failure)
      )
      .map((row) => row.candidate.sessionId),
    interruptedByUpdate: rows.some((row) => row.candidate.trigger === 'update'),
    startedBy: run?.startedBy ?? null
  }
}

/** A settled run's refusals; the run view drops those the host filed no failure for. */
function refusedWithoutRecord(run: ResumeRun | null): ReadonlySet<string> {
  if (!run || run.inFlight) {
    return NO_REFUSALS
  }
  return new Set(
    (run.continued ?? [])
      .filter((entry) => entry.outcome === 'refused')
      .map((entry) => entry.sessionId)
  )
}

const NO_REFUSALS: ReadonlySet<string> = new Set()

function notIn(candidates: readonly ResumeCandidate[]) {
  const ids = new Set(candidates.map((candidate) => candidate.sessionId))
  return (failure: ResumeFailure) => !ids.has(failure.sessionId)
}
