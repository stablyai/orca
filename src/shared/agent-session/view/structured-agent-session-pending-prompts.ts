import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import type { StructuredAgentSessionWorkScope } from './structured-agent-session-main-agent-working'
import { CODEX_ASYNC_QUESTION_TOOL } from '../../codex-async-question-input'
import { isPendingNativeChatUserMessage } from '../../native-chat/input/native-chat-ask-answer'
import { scanPendingAsks } from '../../native-chat/input/native-chat-ask'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { readAgentJournalTurn } from '../lifecycle/agent-session-turn-record'

/** Async questions use delivered message replies and survive completed turns. */
export function pendingStructuredAgentSessionPrompts(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  scope?: StructuredAgentSessionWorkScope
): AgentJournalRenderItem[] {
  const prompts = items.filter(
    (item) =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
  if (
    !items.some(
      (item) =>
        item.body.kind === 'message' &&
        item.body.blocks.some(
          (block) => block.type === 'tool-call' && block.name === CODEX_ASYNC_QUESTION_TOOL
        )
    )
  ) {
    return scope ? prompts.filter((item) => scope.isCurrentItem(item.itemId)) : prompts
  }
  const interrupted = items.findLastIndex(
    (item) => readAgentJournalTurn(item.body)?.state === 'interrupted'
  )
  let cancelledTurn = interrupted !== -1
  const questionItems = items.slice(interrupted + 1).filter((item) => {
    if (readAgentJournalTurn(item.body)) {
      cancelledTurn = false
    }
    return (
      item.body.kind === 'message' &&
      (item.body.role === 'user' ||
        (!cancelledTurn &&
          (!scope || scope.isCurrentItem(item.itemId)) &&
          item.body.role === 'assistant' &&
          item.body.blocks.some(
            (block) => block.type === 'tool-call' && block.name === CODEX_ASYNC_QUESTION_TOOL
          )))
    )
  })
  const messages = projectStructuredAgentSessionMessages(questionItems, [], submissions)
  const asyncIds = new Set(
    scanPendingAsks(
      messages.filter((message) => !isPendingNativeChatUserMessage(message))
    ).contributors.map((entry) => entry.sourceRowId)
  )
  return items.filter(
    (item) =>
      (!scope || scope.isCurrentItem(item.itemId)) &&
      (asyncIds.has(item.itemId) ||
        ((item.body.kind === 'approval' || item.body.kind === 'question') &&
          item.body.resolution.state === 'pending'))
  )
}
