import { isLoneStructuredAgentSessionConversationCommand } from './structured-agent-session-composer'

/** Append returned text without replacing typed drafts or duplicating an existing suffix.
 * Replace lone /compact or /clear commands: they were unsent and cannot accept trailing text. */
export function appendReturnedDraftText(draft: string, text: string): string {
  const returned = text.trimEnd()
  if (returned.trim() === '') {
    return draft
  }
  const kept = draft.trimEnd()
  if (kept === '' || isLoneStructuredAgentSessionConversationCommand(kept)) {
    return text
  }
  if (kept === returned || kept.endsWith(`\n\n${returned}`)) {
    return draft
  }
  return `${kept}\n\n${text}`
}
