// Keep every retry in the journal but draw only each agent run’s latest retry row, preserving intervening non-retry rows.

import { agentJournalItemSubagentId } from '../agent-session-journal-producer'
import type { NativeChatMessage } from '../native-chat-types'
import { isNativeChatContextClear } from '../agent-session-context-clear'

function isProviderRetryRow(message: NativeChatMessage): boolean {
  const block = message.blocks.length === 1 ? message.blocks[0] : undefined
  return (
    message.role === 'system' &&
    block?.type === 'text' &&
    block.failure?.kind === 'providerRetrying'
  )
}

/** Track runs per agent: interleaved conversation/subagent sections cannot end or hide one another’s runs. */
export function collapseProviderRetryRuns(
  messages: readonly NativeChatMessage[]
): readonly NativeChatMessage[] {
  if (!messages.some(isProviderRetryRow)) {
    return messages
  }
  // Each agent's open run, as the index of its latest row in `drawn`.
  const openRuns = new Map<string | null, number>()
  const drawn: (NativeChatMessage | null)[] = []
  for (const message of messages) {
    if (isNativeChatContextClear(message)) {
      openRuns.clear()
    }
    if (!isProviderRetryRow(message)) {
      if (openRuns.size > 0) {
        openRuns.delete(agentJournalItemSubagentId(message))
      }
      drawn.push(message)
      continue
    }
    const agent = agentJournalItemSubagentId(message)
    const previous = openRuns.get(agent)
    if (previous !== undefined) {
      drawn[previous] = null
    }
    openRuns.set(agent, drawn.length)
    drawn.push(message)
  }
  return drawn.filter((message) => message !== null)
}
