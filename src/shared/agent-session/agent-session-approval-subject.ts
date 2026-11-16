// Preserve unknown newer-host subjects and show detail, but permit only Cancel because this build cannot display what approval means. Claude denies and continues; Codex ends the turn.

import type {
  AgentJournalApprovalItem,
  AgentJournalApprovalSubject,
  AgentJournalItemBody,
  AgentJournalPlanApprovalSubject,
  AgentJournalUrlApprovalSubject
} from './journal/agent-session-journal-types'

/** Schema-independent readers share this supported-kind set; a test keeps it aligned with the schema. */
export const DRAWN_APPROVAL_SUBJECT_KINDS: ReadonlySet<string> = new Set(['plan', 'url'])

/** The options a URL approval offers. Choosing `open` means the person opened the page. */
export const URL_APPROVAL_OPEN_OPTION_ID = 'open'
export const URL_APPROVAL_DECLINE_OPTION_ID = 'decline'

export function isPlanApprovalSubject(
  subject: AgentJournalApprovalSubject | undefined
): subject is AgentJournalPlanApprovalSubject {
  return subject?.kind === 'plan'
}

export function isUrlApprovalSubject(
  subject: AgentJournalApprovalSubject | undefined
): subject is AgentJournalUrlApprovalSubject {
  return subject?.kind === 'url'
}

/** The http(s) URL to open and the host to show for it; null for anything else, which is never opened. */
export function readApprovalUrl(url: string): { href: string; host: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // `host` is the punycode form, so a look-alike domain shows as what it really is.
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host
    ? { href: parsed.href, host: parsed.host }
    : null
}

/** Where a URL approval stands once answered: the page was opened, and maybe finished. */
export function urlApprovalProgress(
  body: AgentJournalApprovalItem
): { subject: AgentJournalUrlApprovalSubject; finished: boolean } | null {
  return isUrlApprovalSubject(body.subject) &&
    body.resolution.state === 'resolved' &&
    body.resolution.selectedOptionId === URL_APPROVAL_OPEN_OPTION_ID
    ? { subject: body.subject, finished: body.subject.completedAt !== undefined }
    : null
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
