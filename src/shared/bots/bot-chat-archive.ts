// A desktop navigation choice keyed by host, bot and chat, gated by the host's activity watermark.
import { botChatFoldKey, type BotChatTreeChat } from './bot-chat-tree'

export type BotChatArchive = Readonly<Record<string, number>>

export function canArchiveBotChat(chat: BotChatTreeChat): boolean {
  return (
    chat.origin !== 'home' &&
    !chat.run &&
    chat.live === 'idle' &&
    chat.runningTotal === 0 &&
    !chat.unread &&
    !chat.unseen
  )
}

export function isBotChatArchived(
  entries: BotChatArchive,
  hostId: string,
  botId: string,
  chat: BotChatTreeChat
): boolean {
  const at = entries[botChatFoldKey(hostId, botId, chat.chatId)]
  return at !== undefined && canArchiveBotChat(chat) && chat.lastActiveAt <= at
}

export function withBotChatArchive(
  entries: BotChatArchive,
  hostId: string,
  botId: string,
  chat: BotChatTreeChat,
  archived: boolean
): BotChatArchive {
  const key = botChatFoldKey(hostId, botId, chat.chatId)
  if (archived) {
    if (!canArchiveBotChat(chat) || entries[key] === chat.lastActiveAt) {
      return entries
    }
    return { ...entries, [key]: chat.lastActiveAt }
  }
  if (!(key in entries)) {
    return entries
  }
  const next = { ...entries }
  delete next[key]
  return next
}

/** A stored archive, or null when anything in it is malformed. */
export function parseBotChatArchive(value: unknown): BotChatArchive | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return null
  }
  const entries: Record<string, number> = {}
  for (const [key, watermark] of Object.entries(value)) {
    if (typeof watermark !== 'number' || !Number.isFinite(watermark)) {
      return null
    }
    entries[key] = watermark
  }
  return entries
}

/** Malformed stored data hides nothing. */
export function botChatArchiveOrEmpty(value: unknown): BotChatArchive {
  return parseBotChatArchive(value) ?? {}
}
