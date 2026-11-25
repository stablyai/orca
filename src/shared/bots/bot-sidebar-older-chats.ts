// Which of a bot's sidebar chats fold under its "Show N older" link: presentation only, nothing closes.
import { chatIsGoing } from './bot-chat-tree'
import type { BotSidebarChatView } from './bot-sidebar-tree'

/** A settled chat this long untouched, and not focused this long, folds. */
export const OLDER_BOT_CHAT_AGE_MS = 24 * 60 * 60 * 1000

/** Fewer than this qualifying, nothing folds: a one-row fold saves nothing. */
const OLDER_BOT_CHATS_MIN = 2

export type OlderBotSidebarChats<T> = {
  recent: BotSidebarChatView<T>[]
  older: BotSidebarChatView<T>[]
}

/** The sidebar's chats split into those that list and those that fold as older, each in the given order.
 *  Home, anything going or waiting on the owner, anything moved or focused within a day, the chat in front
 *  and a chat holding a live or open line always list. */
export function splitOlderBotSidebarChats<T extends { id: string }>(
  chats: readonly BotSidebarChatView<T>[],
  input: {
    now: number
    /** When each chat's tab was last focused, by chat id. */
    focusedAt: ReadonlyMap<string, number>
    activeChatId: string | null
    liveLineIds: ReadonlySet<string>
    activeLineId: string | null
  }
): OlderBotSidebarChats<T> {
  const cutoff = input.now - OLDER_BOT_CHAT_AGE_MS
  const isOlder = ({ chat, lines }: BotSidebarChatView<T>): boolean =>
    chat.origin !== 'home' &&
    !chatIsGoing(chat) &&
    chat.lastActiveAt > 0 &&
    chat.lastActiveAt <= cutoff &&
    chat.chatId !== input.activeChatId &&
    (input.focusedAt.get(chat.chatId) ?? 0) <= cutoff &&
    !lines.some((line) => input.liveLineIds.has(line.id) || line.id === input.activeLineId)
  const older = chats.filter(isOlder)
  if (older.length < OLDER_BOT_CHATS_MIN) {
    return { recent: [...chats], older: [] }
  }
  return { recent: chats.filter((view) => !isOlder(view)), older }
}
