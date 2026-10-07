import { isPlanApprovalSubject } from './agent-session-approval-subject'
import type { AgentJournalApprovalSubject } from './agent-session-journal-types'

export type ApprovalCardText = {
  blockedPath?: string
  description?: string
  decisionReason?: string
  subject?: AgentJournalApprovalSubject
  detail?: string
}

/** The path an approval needs access to, or null when the card's own text already shows it. */
export function approvalBlockedPathToShow(approval: ApprovalCardText): string | null {
  const path = approval.blockedPath
  if (!path) {
    return null
  }
  // Visible = the path appears verbatim, or JSON-escaped (tool input renders as JSON), in text the card draws.
  const forms = [path, JSON.stringify(path).slice(1, -1)]
  const drawn = isPlanApprovalSubject(approval.subject)
    ? [approval.subject.text, approval.subject.filePath]
    : [approval.detail]
  const shown = [approval.description, approval.decisionReason, ...drawn].some(
    (text) => text !== undefined && forms.some((form) => containsWholePath(text, form))
  )
  return shown ? null : path
}

// A backslash also starts a JSON escape (`\\`, `\"`) after the escaped form.
const PATH_END = /[\s'"`/\\]/

/** Whether `path` occurs in `text` without continuing into a longer name ('/srv/data' in '/srv/data-old'). */
function containsWholePath(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const next = text[at + path.length]
    if (next === undefined || PATH_END.test(next)) {
      return true
    }
  }
  return false
}
