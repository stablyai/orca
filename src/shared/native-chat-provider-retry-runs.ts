// A provider retrying writes a row per attempt, and the journal keeps them all. A transcript
// draws only the latest row of each agent's run: its retry rows, none of its other rows between.

import { agentJournalItemSubagentId } from './agent-session-journal-producer'
import type { NativeChatMessage } from './native-chat-types'

function isProviderRetryRow(message: NativeChatMessage): boolean {
  const block = message.blocks.length === 1 ? message.blocks[0] : undefined
  return (
    message.role === 'system' &&
    block?.type === 'text' &&
    block.failure?.kind === 'providerRetrying'
  )
}

/** Runs are per agent because each agent's rows are drawn apart (the conversation, or a
 *  subagent's section), so another agent's row never ends a run and one never hides another's. */
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
