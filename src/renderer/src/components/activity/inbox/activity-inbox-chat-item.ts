// Which of a bot's items a notification from one of its chats is about, so opening the notification opens that
// item on the right, not just the bot's Home.
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { BOT_ITEM_OPEN_STATUSES } from '../../../../../shared/bots/bot-items'
import { structuredAgentSessionIdOfTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentPaneThread } from '../threads/activity-thread-types'

/** The chat's item: one waiting on you first, then one still open, then the newest; null when none is known. */
export function botItemForChat(
  thread: Pick<AgentPaneThread, 'tab'>,
  items: readonly BotItem[] | null
): BotItem | null {
  const sessionId = structuredAgentSessionIdOfTab(thread.tab.id)
  if (!sessionId || !items) {
    return null
  }
  const rank = (item: BotItem): number =>
    item.status === 'needs_you' ? 0 : BOT_ITEM_OPEN_STATUSES.includes(item.status) ? 1 : 2
  let best: BotItem | null = null
  for (const item of items) {
    if (item.chat.id !== sessionId && item.madeBy?.chatId !== sessionId) {
      continue
    }
    if (
      !best ||
      rank(item) < rank(best) ||
      (rank(item) === rank(best) && item.lastActivityAt > best.lastActivityAt)
    ) {
      best = item
    }
  }
  return best
}
