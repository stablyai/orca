import { finishAgentSessionSteps } from '../agent-session/agent-session-projection-steps'
// Keep every retry in the journal but draw only each agent run’s latest retry row, preserving intervening non-retry rows.

import { agentJournalItemSubagentId } from '../agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessage } from './native-chat-types'
import { isNativeChatContextClear } from '../agent-session/agent-session-context-clear'

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
  return finishAgentSessionSteps(collapseProviderRetryRunSteps(messages))
}
export function* collapseProviderRetryRunSteps(
  messages: readonly NativeChatMessage[]
): Generator<void, readonly NativeChatMessage[]> {
  // Each agent's open run, as the index of its latest row in `drawn`.
  let hasRetry = false
  const openRuns = new Map<string | null, number>()
  const drawn: (NativeChatMessage | null)[] = []
  for (const message of messages) {
    yield
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
    hasRetry = true
    const agent = agentJournalItemSubagentId(message)
    const previous = openRuns.get(agent)
    if (previous !== undefined) {
      drawn[previous] = null
    }
    openRuns.set(agent, drawn.length)
    drawn.push(message)
  }
  if (!hasRetry) {
    return messages
  }
  const result: NativeChatMessage[] = []
  for (const message of drawn) {
    if (message !== null) {
      result.push(message)
    }
    yield
  }
  return result
}
