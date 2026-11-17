import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../requests/structured-agent-session-command-entry'
import { scanPendingAsks } from '../../native-chat/input/native-chat-ask'
import { isDeliveredNativeChatUserMessage } from '../../native-chat/input/questions/native-chat-ask-answer'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

/** Rows the question rule reads: command entries never reach the agent, so they answer nothing. */
export function isStructuredAgentSessionAsyncQuestionRow(item: AgentJournalRenderItem): boolean {
  return isRootAgentJournalItem(item) && !isStructuredAgentSessionCommandEntry(item.body)
}

/** The row of the newest Codex async question still waiting for the person's next delivered
 *  message, read the way the chat's question card reads it (another agent's message answers none). */
export function newestOpenStructuredAgentSessionAsyncQuestion(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): string | undefined {
  const messages = projectStructuredAgentSessionMessages(
    items.filter(isStructuredAgentSessionAsyncQuestionRow),
    [],
    submissions
  )
  const start = messages.findLastIndex(isDeliveredNativeChatUserMessage)
  return scanPendingAsks(messages.slice(Math.max(start, 0))).contributors.at(-1)?.sourceRowId
}

/** Skip hides the skipped row's questions and every earlier one; a row not among them hides none. */
export function asyncQuestionsAfterSkip<T extends { sourceRowId: string }>(
  contributors: readonly T[],
  skippedThrough: string | undefined
): readonly T[] {
  const skipped =
    skippedThrough === undefined
      ? -1
      : contributors.findLastIndex((contributor) => contributor.sourceRowId === skippedThrough)
  return skipped < 0 ? contributors : contributors.slice(skipped + 1)
}

/** The host's waiting state: the newest open question is one the person has not skipped. */
export function structuredAgentSessionAwaitsAnswer(
  openQuestionRowId: string | undefined,
  skippedThrough: string | undefined
): boolean {
  return openQuestionRowId !== undefined && openQuestionRowId !== skippedThrough
}
