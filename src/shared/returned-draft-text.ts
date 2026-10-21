import { isLoneStructuredAgentSessionConversationCommand } from './structured-agent-session-composer'

/**
 * Puts text a chat handed back after what the composer already holds, a blank line apart. It never
 * replaces typed text (a whitespace-only draft counts as empty), except a lone conversation command
 * (`/compact`, `/clear`), which takes no text after it and was never sent: the message takes its place, so
 * neither is left unusable. It adds nothing when the draft already ends with that text, so handing
 * the same text back twice leaves one copy.
 */
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
