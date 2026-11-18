/** How a chat is printed and named in `--chat`; `--chat` takes it with or without the prefix. */
export const BOT_CHAT_ID_PREFIX = 'chat:'

/** One of a bot's chats, as `orca bot chats` lists it; `id` is its Orca session id, for `--chat`. */
export type BotChatRow = {
  id: string
  title: string | null
  lastActivityAt: number
  lastAsked: string | null
  lastSaid: string | null
  /** The bot's Home Chat, which `--to bot:<name>` without --chat reaches. */
  home: boolean
  /** The chat asking for the list. */
  self: boolean
  /** Takes no mail now: the delivery check refuses it (closed, run elsewhere, or not checkable). */
  closed: boolean
  /** Why a closed chat takes no mail; absent while it takes mail, and from an older host. */
  reason?: BotChatUnreachable
}

/** Why one of a bot's chats takes no mail, from the delivery check's own refusal. */
export type BotChatUnreachable = 'ended' | 'other-host' | 'unverifiable'
