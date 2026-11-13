import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import { agentSessionPromptQuestions } from '../agent-session/agent-session-question-answer'
import type { AgentReadEntry } from './agent-conversation-contracts'

/** Whether a chat item can become an `orca agent read` entry by its kind alone: its own
 *  messages, failures, tool calls, approvals and questions. Status frames, turn markers and
 *  subagent rows never do. */
export function isAgentChatEntryKind(item: AgentJournalRenderItem): boolean {
  if (!isRootAgentJournalItem(item)) {
    return false
  }
  const { body } = item
  return (
    (body.kind === 'message' && body.role !== 'reasoning') ||
    (body.kind === 'status' && body.tone === 'error') ||
    body.kind === 'tool-call' ||
    body.kind === 'approval' ||
    body.kind === 'question'
  )
}

/** The conversation as a reader follows it. `waiting`: whether a pending approval or question
 *  can still be answered; an ended agent's stay pending in the journal but cannot. */
export function agentChatEntryOf(
  item: AgentJournalRenderItem,
  waiting: (itemId: string) => boolean
): AgentReadEntry | null {
  if (!isAgentChatEntryKind(item)) {
    return null
  }
  const { body } = item
  if (body.kind === 'message') {
    const text = body.blocks
      .map((block) =>
        block.type === 'text' ? block.text : block.type === 'image-ref' ? '[image]' : ''
      )
      .filter((part) => part.length > 0)
      .join('\n')
      .trim()
    return text.length > 0 ? { kind: 'message', role: body.role, text } : null
  }
  if (body.kind === 'status') {
    return { kind: 'error', text: String(body.text) }
  }
  if (body.kind === 'tool-call') {
    return { kind: 'tool', name: body.name, state: body.state }
  }
  if (body.kind === 'approval') {
    return {
      kind: 'approval',
      text: body.title,
      pending: body.resolution.state === 'pending' && waiting(item.itemId)
    }
  }
  if (body.kind === 'question') {
    return {
      kind: 'question',
      // Grouped prompts keep their real questions in `questions`; `question` is then a heading.
      text: agentSessionPromptQuestions(body)
        .map((question) => question.question)
        .join('\n'),
      pending: body.resolution.state === 'pending' && waiting(item.itemId)
    }
  }
  return null
}
