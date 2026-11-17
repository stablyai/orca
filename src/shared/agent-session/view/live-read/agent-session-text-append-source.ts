import type { AgentJournalRenderItem } from '../../journal/agent-session-journal-types'

/** Host-only proof that two immutable rows came from the same append-only buffer. */
export type AgentSessionTextAppendSource = {
  identity: object
  length: number
  suffix: (from: number) => string
}

const sources = new WeakMap<AgentJournalRenderItem, AgentSessionTextAppendSource>()

export function noteAgentSessionTextAppendSource(
  item: AgentJournalRenderItem,
  source: AgentSessionTextAppendSource
): void {
  sources.set(item, source)
}

export function agentSessionTextAppendSource(
  item: AgentJournalRenderItem
): AgentSessionTextAppendSource | undefined {
  return sources.get(item)
}
