import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../structured-agent-session-command-entry'
import { scanPendingAsks } from '../../native-chat/input/native-chat-ask'
import { isDeliveredNativeChatUserMessage } from '../../native-chat/input/questions/native-chat-ask-answer'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

/** The person's delivered message answers every earlier async question; one from another agent
 *  ends the read too, so a status check stays inside the current exchange. */
export function endsStructuredAgentSessionAsyncQuestionRead(message: NativeChatMessage): boolean {
  return (
    isDeliveredNativeChatUserMessage(message) ||
    (message.role === 'user' && message.from?.kind === 'agent')
  )
}

/** Codex's async question waits for the next delivered message, read the way the chat's question
 *  card reads it. Command entries never reach the agent, so they answer nothing. */
export function hasOpenStructuredAgentSessionAsyncQuestion(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): boolean {
  const rows = items.filter(
    (item) => isRootAgentJournalItem(item) && !isStructuredAgentSessionCommandEntry(item.body)
  )
  const messages = projectStructuredAgentSessionMessages(rows, [], submissions)
  const start = messages.findLastIndex(endsStructuredAgentSessionAsyncQuestionRead)
  return scanPendingAsks(messages.slice(Math.max(start, 0))).contributors.length > 0
}
