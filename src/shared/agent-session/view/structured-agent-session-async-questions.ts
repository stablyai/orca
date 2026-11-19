import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../requests/structured-agent-session-command-entry'
import {
  scanPendingAsks,
  type AsyncQuestionContributor
} from '../../native-chat/input/native-chat-ask'
import { isDeliveredNativeChatUserMessage } from '../../native-chat/input/questions/native-chat-ask-answer'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import type { AgentSessionAwaitedQuestion } from '../agent-session-wire'
import { normalizeOptionalMultilineField } from '../../agent-status/contracts/agent-status-field-normalization'
import { AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH } from '../../agent-status/contracts/agent-status-types'

/** Rows the question rule reads: command entries never reach the agent, so they answer nothing. */
export function isStructuredAgentSessionAsyncQuestionRow(item: AgentJournalRenderItem): boolean {
  return isRootAgentJournalItem(item) && !isStructuredAgentSessionCommandEntry(item.body)
}

/** The newest Codex async question still waiting for the person's next delivered message, read
 *  the way the chat's question card reads it (another agent's message answers none). */
export function newestOpenStructuredAgentSessionAsyncQuestion(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): AgentSessionAwaitedQuestion | undefined {
  const messages = projectStructuredAgentSessionMessages(
    items.filter(isStructuredAgentSessionAsyncQuestionRow),
    [],
    submissions
  )
  const start = messages.findLastIndex(isDeliveredNativeChatUserMessage)
  const open = scanPendingAsks(messages.slice(Math.max(start, 0))).contributors.at(-1)
  if (!open) {
    return undefined
  }
  // Kept whole and multiline, bounded like the assistant's own prose, so a card can show it as asked.
  const text = open.questions.map((question) => question.question).join('\n\n')
  return {
    itemId: open.sourceRowId,
    text: normalizeOptionalMultilineField(text, AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH) ?? ''
  }
}

/** The async questions a chat shows: those its loaded messages hold, led by the one its host waits
 *  on when that row is older than them, then the host's saved Skip. Every loaded message is newer
 *  than such a row, so a delivered one of the person's already answers it. */
export function shownStructuredAgentSessionAsyncQuestions(
  contributors: readonly AsyncQuestionContributor[],
  messages: readonly NativeChatMessage[] | null,
  host: { awaiting?: AgentSessionAwaitedQuestion; skippedThrough?: string }
): readonly AsyncQuestionContributor[] {
  const { awaiting } = host
  const older =
    awaiting?.text &&
    messages &&
    !messages.some(
      (message) => message.id === awaiting.itemId || isDeliveredNativeChatUserMessage(message)
    )
      ? [
          {
            sourceRowId: awaiting.itemId,
            callSlot: 0,
            timestamp: null,
            questions: [{ question: awaiting.text, multiSelect: false, options: [] }],
            responseMode: 'message' as const
          }
        ]
      : []
  return asyncQuestionsAfterSkip([...older, ...contributors], host.skippedThrough)
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
  open: AgentSessionAwaitedQuestion | undefined,
  skippedThrough: string | undefined
): boolean {
  return open !== undefined && open.itemId !== skippedThrough
}
