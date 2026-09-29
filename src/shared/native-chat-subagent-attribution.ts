// Whose words a transcript row carries, when they are not the session's own agent's.
//
// A session's subagents write into its journal, and the transcript keeps their rows
// where they happened. Each such row names the subagent that wrote it, using the
// label that subagent's spawn roster already gives it, so a child's words are never
// read as its parent's. Shared so desktop and mobile name the same agent.

import { agentJournalItemSubagentId } from './agent-session-journal-producer'
import { isSubagentGroupBlock, type NativeChatMessage } from './native-chat-types'

/** English copy: the desktop's i18n fallbacks, and mobile's text as-is. */
export const NATIVE_CHAT_SUBAGENT_ATTRIBUTION_COPY = {
  unnamed: 'Subagent',
  writtenBy: 'Written by subagent {{value0}}'
} as const

/** Each subagent's roster label, by the id its rows carry. */
export function nativeChatSubagentLabels(
  messages: readonly NativeChatMessage[]
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (isSubagentGroupBlock(block)) {
        for (const agent of block.agents) {
          labels.set(agent.id, agent.label)
        }
      }
    }
  }
  return labels
}

/** The roster's name for the subagent that wrote a row. Undefined for the
 *  session's own rows, and for a subagent no loaded roster names. */
export function nativeChatSubagentLabel(
  labels: ReadonlyMap<string, string> | undefined,
  message: NativeChatMessage
): string | undefined {
  const agentId = agentJournalItemSubagentId(message)
  return agentId === null ? undefined : labels?.get(agentId)
}
