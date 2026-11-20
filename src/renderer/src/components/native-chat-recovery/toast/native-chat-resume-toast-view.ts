import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import {
  resumeFailureGuidance,
  resumeFailureSelectable
} from '../failures/native-chat-resume-failure-guidance'

export type ResumeToastRowState = 'stopped' | 'needs-you'

export type ResumeToastRow = Readonly<{
  candidate: ResumeCandidate
  state: ResumeToastRowState
  failure?: ResumeFailure
}>

/** What still waits on the person: chats to resume and chats that couldn't. A resumed chat shows its
 *  own progress, so nothing here follows a resume once its chats are handed over. */
export type ResumeToastView = Readonly<{
  rows: readonly ResumeToastRow[]
  counts: Readonly<{ needsYou: number; total: number }>
  /** What the toast's one Resume button sends: every chat a retry could still help. */
  resumable: readonly string[]
  interruptedByUpdate: boolean
}>

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

export function resumeToastView(
  candidates: readonly ResumeCandidate[],
  failed: readonly ResumeFailure[]
): ResumeToastView {
  const failureBySession = new Map(failed.map((failure) => [failure.sessionId, failure]))
  const offered = new Set(candidates.map((candidate) => candidate.sessionId))
  const listed = [...candidates, ...failed.filter((failure) => !offered.has(failure.sessionId))]
  const rows = listed
    .map((candidate): ResumeToastRow => {
      const failure = failureBySession.get(candidate.sessionId)
      return failure ? { candidate, state: 'needs-you', failure } : { candidate, state: 'stopped' }
    })
    .sort((a, b) => Number(b.state === 'needs-you') - Number(a.state === 'needs-you'))
  return {
    rows,
    counts: {
      needsYou: rows.filter((row) => row.state === 'needs-you').length,
      total: rows.length
    },
    resumable: rows
      .filter((row) => resumableByDefault(row.failure))
      .map((row) => row.candidate.sessionId),
    interruptedByUpdate: rows.some((row) => row.candidate.trigger === 'update')
  }
}
