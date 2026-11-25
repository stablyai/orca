// A bot's settled chats that nobody touched for a day fold under one "Show N older" row in the sidebar,
// so finished and failed request chats stop crowding the live ones. Presentation only: nothing is
// closed or changed, and a chat comes back up as soon as anything about it needs a look.
import type { BotChatTreeChat } from './bot-chat-tree'

/** How long a settled chat sits untouched before it folds under "older". */
export const BOT_SIDEBAR_OLDER_AFTER_MS = 24 * 60 * 60 * 1000

/** The chat id the sidebar's older/folded choice is kept under, beside each chat's own fold. */
export const BOT_SIDEBAR_OLDER_FOLD_ID = '\u0000older'

export type BotSidebarOlderKeep = {
  now: number
  /** The chat whose tab is in front, if it is this bot's. */
  frontChatId: string | null
  /** When each chat's tab was last focused, by chat id; absent when never or unknown. */
  focusedAt: (chatId: string) => number | undefined
  /** Chats the person opened to show their workers. */
  openChatIds: ReadonlySet<string>
  /** Chats holding the open workspace line. */
  activeLineChatIds: ReadonlySet<string>
}

/** Whether a listed chat folds under "older": settled, nothing new in it, not in use, a day untouched. */
export function botSidebarChatIsOlder(chat: BotChatTreeChat, keep: BotSidebarOlderKeep): boolean {
  if (
    chat.origin === 'home' ||
    chat.live !== 'idle' ||
    chat.runningTotal > 0 ||
    chat.unread ||
    chat.unseen === true ||
    chat.chatId === keep.frontChatId ||
    keep.openChatIds.has(chat.chatId) ||
    keep.activeLineChatIds.has(chat.chatId)
  ) {
    return false
  }
  const focused = keep.focusedAt(chat.chatId)
  if (focused !== undefined && keep.now - focused < BOT_SIDEBAR_OLDER_AFTER_MS) {
    return false
  }
  return chat.lastActiveAt > 0 && keep.now - chat.lastActiveAt >= BOT_SIDEBAR_OLDER_AFTER_MS
}

/** Fewer than this many older rows show inline: a fold row in place of one row saves nothing. */
export const BOT_SIDEBAR_OLDER_MIN = 2

/** The listed rows split into those shown and those folded under "older", each in the given order.
 *  `held`: rows on screen that may not move into the fold now (the person is over or in the list);
 *  rows only ever leave the fold at once. */
export function splitOlderBotSidebarChats<V extends { chat: BotChatTreeChat }>(
  views: readonly V[],
  keep: BotSidebarOlderKeep,
  held: ReadonlySet<string> = new Set()
): { recent: V[]; older: V[] } {
  const isOlder = (view: V) => !held.has(view.chat.chatId) && botSidebarChatIsOlder(view.chat, keep)
  const older = views.filter(isOlder)
  if (older.length < BOT_SIDEBAR_OLDER_MIN) {
    return { recent: [...views], older: [] }
  }
  return { recent: views.filter((view) => !isOlder(view)), older }
}
