import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../../../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalCursor } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  nativeChatForkInventory,
  nativeChatLatestForkItemId,
  type NativeChatForkSupport
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

/** The fork point offered from one of your own messages. A tip-only agent forks only its newest
 *  reply, or, with original-resolution support, a reply copied from the chat it was forked from. */
export function nativeChatUserForkPoint(
  chat: Parameters<typeof nativeChatForkPoint>[0] & { support: NativeChatForkSupport },
  beforeItemId: string
): string | undefined {
  const point = nativeChatForkPoint(chat, beforeItemId)
  const { support, items } = chat
  if (point === undefined || support.kind !== 'known' || support.fork !== 'tip') {
    return point
  }
  if (point === nativeChatForkPoint(chat)) {
    return point
  }
  const sequence = items.find((item) => item.itemId === point)?.sequence
  return support.inheritedOriginal === true &&
    sequence !== undefined &&
    sequence <= nativeChatForkInventory(items).inheritedThroughSequence
    ? point
    : undefined
}
