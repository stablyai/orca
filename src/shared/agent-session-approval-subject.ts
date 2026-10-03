// An approval subject of a kind this build cannot draw is a newer Orca's. It is carried as it was,
// its card shows the approval's `detail`, and only the card's cancel answers it: nobody approves
// what this build cannot show. On Claude the cancel denies the request and the turn goes on; on
// Codex it ends the turn.

import type {
  AgentJournalApprovalSubject,
  AgentJournalItemBody,
  AgentJournalPlanApprovalSubject
} from './agent-session-journal-types'

/** The subject kinds this build draws: the known arms of the journal schema's approval subject.
 *  A copy, kept equal by a test, so clients that never load the schema module can read it. */
export const DRAWN_APPROVAL_SUBJECT_KINDS: ReadonlySet<string> = new Set(['plan'])

export function isPlanApprovalSubject(
  subject: AgentJournalApprovalSubject | undefined
): subject is AgentJournalPlanApprovalSubject {
  return subject?.kind === 'plan'
}

export function isNewerApprovalSubject(subject: { kind: string } | undefined): boolean {
  return subject !== undefined && !DRAWN_APPROVAL_SUBJECT_KINDS.has(subject.kind)
}

/** Every pending prompt is an approval this build cannot answer. Nothing here can settle them, so
 *  the composer stays open and a send starts a turn now instead of queueing behind them; with a
 *  turn running, the card's cancel works. */
export function pendingPromptsAllUnanswerableHere(
  items: readonly { body: AgentJournalItemBody }[]
): boolean {
  let found = false
  for (const { body } of items) {
    if (
      (body.kind === 'approval' || body.kind === 'question') &&
      body.resolution.state === 'pending'
    ) {
      if (body.kind === 'question' || !isNewerApprovalSubject(body.subject)) {
        return false
      }
      found = true
    }
  }
  return found
}
