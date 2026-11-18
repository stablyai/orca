// A bot's automation results ride a person's next message to the agent; these mark which did.
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import { latestAgentSessionContextClearSequence } from '../agent-session/conversation-context/agent-session-context-clear'
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { automationResultNoteOf } from './bot-automation-result-note'

type AutomationResultMarks = {
  /** How many notes each person's message carried to the agent, by its row id. */
  carried: Map<string, number>
  /** Unread notes a later /clear left out of the agent's context: they never ride. */
  cleared: Set<string>
}

export function automationResultMarks(
  items: readonly AgentJournalRenderItem[]
): AutomationResultMarks {
  const marks: AutomationResultMarks = { carried: new Map(), cleared: new Set() }
  const floor = latestAgentSessionContextClearSequence(items)
  for (const { body, itemId, sequence } of items) {
    const note = body.kind === 'status' ? automationResultNoteOf(body) : null
    if (note?.readWith !== undefined) {
      const key = agentJournalSubmissionKey(note.readWith)
      marks.carried.set(key, (marks.carried.get(key) ?? 0) + 1)
    } else if (note && sequence < floor) {
      marks.cleared.add(itemId)
    }
  }
  return marks
}

export function withAutomationResultMarks(
  message: NativeChatMessage,
  { carried, cleared }: AutomationResultMarks
): NativeChatMessage {
  const count = carried.get(message.id)
  if (count) {
    return { ...message, automationResultsCarried: count }
  }
  if (!cleared.has(message.id)) {
    return message
  }
  return {
    ...message,
    blocks: message.blocks.map((block) =>
      block.type === 'text' && block.automationResult
        ? { ...block, automationResultCleared: true as const }
        : block
    )
  }
}
