// One level under a bot in the `@` list: its chats this chat can mail now, and how a picked one reads.
import type { ReactNode } from 'react'

/** One of a bot's chats, as its row in the bot's Activity panel shows it. */
export type NativeChatMentionChat = {
  id: string
  title: string
  /** What typing after the bot filters on: the title and the second line. */
  search: string
  icon: ReactNode
  line: ReactNode
  time: string | null
  /** Picking it gives the plain bot pill: another bot's Home Chat, which `bot:` alone reaches. */
  plain: boolean
}

export type NativeChatMentionChatsView =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; chats: readonly NativeChatMentionChat[] }

/** A picked chat as Send may carry it: still being checked, fine, or not, with why in a sentence. */
export type NativeChatBotChatPick =
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'unavailable'; why: ReactNode; retry?: () => void }

/** A chat composer's way into its bots' chats; absent where none can be picked. */
export type NativeChatBotChatPicker = {
  /** The bot's row offers Chats ›: its host takes chat picks and it isn't paused. */
  offers: (botId: string) => boolean
  /** The chat's own bot: listed first, and Enter or Tab on it opens its chats. */
  selfId: string | null
  /** The bots the draft's chat pills name, so their chats are read and kept current. */
  watch: (botIds: readonly string[]) => void
  /** Starts reading the bot's chats, as a highlighted row does. */
  prefetch: (botId: string) => void
  /** The bot whose chats a list shows now; null closes it. */
  view: (botId: string | null) => void
  shown: {
    botId: string
    name: string
    avatar: ReactNode
    chats: NativeChatMentionChatsView
  } | null
  retry: () => void
  /** What picking `chat` (null: the bot alone) puts in the draft. */
  token: (botId: string, chat: NativeChatMentionChat | null) => string
  /** Whether Send may carry a picked chat; a host that can't take chat picks never may. */
  pick: (botId: string, chatId: string) => NativeChatBotChatPick
  /** The picked chat's title as it reads now, looked up by id. */
  title: (botId: string, chatId: string) => ReactNode
}

/** Chats whose title or second line holds every word typed, in list order; spaces separate words. */
export function filterNativeChatMentionChats(
  chats: readonly NativeChatMentionChat[],
  filter: string
): readonly NativeChatMentionChat[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return chats
  }
  return chats.filter((chat) => {
    const text = chat.search.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}
