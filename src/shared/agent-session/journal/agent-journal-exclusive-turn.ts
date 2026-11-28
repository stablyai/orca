// Orca's maintenance turns: they hold the chat to themselves while they run (nothing steers into
// them, mail and connector deliveries included) and recovery never continues or resends them.
import type { AgentJournalItemBody } from './agent-session-journal-types'

/** Whether a message is Orca's memory-save request to a bot. */
export function isBotMemorySaveMessage(body: AgentJournalItemBody | null | undefined): boolean {
  return body?.kind === 'message' && body.origin === 'memory-save'
}

/** Whether the turn this opener started holds the chat to itself. */
export function isJournalExclusiveTurnOpener(
  opener: { body: AgentJournalItemBody } | null | undefined
): boolean {
  return isBotMemorySaveMessage(opener?.body)
}
