import { isLoneStructuredAgentSessionConversationCommand } from '../../../agent-session/view/structured-agent-session-composer'

/** Whether returned text replaces `draft` rather than appending to it: an empty draft or a lone command. */
export function returnedDraftTextReplaces(
  draft: string,
  options?: { preserveConversationCommands?: boolean }
): boolean {
  const kept = draft.trimEnd()
  return (
    kept === '' ||
    (!options?.preserveConversationCommands &&
      isLoneStructuredAgentSessionConversationCommand(kept))
  )
}

/** Append returned text without replacing typed drafts or duplicating an existing suffix.
 * Replace lone /compact, /clear or /new commands: they were unsent, and trailing text would read as their arguments. */
export function appendReturnedDraftText(
  draft: string,
  text: string,
  options?: { preserveConversationCommands?: boolean }
): string {
  const returned = text.trimEnd()
  if (returned.trim() === '') {
    return draft
  }
  const kept = draft.trimEnd()
  if (returnedDraftTextReplaces(draft, options)) {
    return text
  }
  if (kept === returned || kept.endsWith(`\n\n${returned}`)) {
    return draft
  }
  return `${kept}\n\n${text}`
}
