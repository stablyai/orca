/** Where the person sent a user message from when it was not Orca. Persisted and open for growth: a
 *  reader that cannot place a value renders an ordinary message. */
export const AGENT_JOURNAL_MESSAGE_SOURCES = ['provider-remote-control'] as const
export type AgentJournalMessageSource = (typeof AGENT_JOURNAL_MESSAGE_SOURCES)[number]

export function isAgentJournalMessageSource(value: string): value is AgentJournalMessageSource {
  return AGENT_JOURNAL_MESSAGE_SOURCES.some((source) => source === value)
}
