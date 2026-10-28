// Preserve unknown newer-host subjects and show detail, but permit only Cancel because this build cannot display what approval means. Claude denies and continues; Codex ends the turn.

import type {
  AgentJournalApprovalSubject,
  AgentJournalItemBody,
  AgentJournalPlanApprovalSubject
} from './agent-session-journal-types'

/** Schema-independent readers share this supported-kind set; a test keeps it aligned with the schema. */
export const DRAWN_APPROVAL_SUBJECT_KINDS: ReadonlySet<string> = new Set(['plan'])

export function isPlanApprovalSubject(
  subject: AgentJournalApprovalSubject | undefined
): subject is AgentJournalPlanApprovalSubject {
  return subject?.kind === 'plan'
}

export function isNewerApprovalSubject(subject: { kind: string } | undefined): boolean {
  return subject !== undefined && !DRAWN_APPROVAL_SUBJECT_KINDS.has(subject.kind)
}

/** Unanswerable prompts cannot settle here; keep composer open so sending starts a turn whose card can then cancel. */
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
