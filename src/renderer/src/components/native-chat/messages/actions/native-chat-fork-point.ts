import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../../../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalCursor } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  nativeChatForkInventory,
  nativeChatLatestForkItemId
} from '../../../../../../shared/native-chat/native-chat-fork-offer'

/** The newest response still in context that a fork copies through; with `beforeItemId`, the newest
 *  one before that item, as when forking from one of your own messages. */
export function nativeChatForkPoint(
  chat: {
    items: readonly AgentJournalRenderItem[]
    contextFloor: AgentJournalCursor | undefined
    epoch: string | null
  },
  beforeItemId?: string
): string | undefined {
  const { items } = chat
  let candidates = items
  if (beforeItemId !== undefined) {
    const before = items.find((item) => item.itemId === beforeItemId)
    if (!before) {
      return undefined
    }
    candidates = items.filter((item) => item.sequence < before.sequence)
  }
  return nativeChatLatestForkItemId(candidates, {
    contextFloorSequence: Math.max(
      latestAgentSessionContextClearSequence(items),
      agentSessionContextFloorSequence(chat.contextFloor, chat.epoch)
    ),
    forkableItemIds: nativeChatForkInventory(items).forkableItemIds
  })
}
