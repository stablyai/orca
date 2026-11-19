// A bot's chat search over everything its host holds: every chat by title, place and last message,
// and every worker by title. Pure, so the host runs it and a test can time it.
import type { BotChatTreeChat } from './bot-chat-tree'
import { isBotGroupMemberSession } from './bot-group'

/** Chat blocks a search returns at most; the rest only count. */
export const BOT_CHAT_SEARCH_LIMIT = 30
/** Matching workers listed under one chat at most. */
export const BOT_CHAT_SEARCH_WORKERS_PER_CHAT = 8

export type BotChatSearchChat = {
  chatId: string
  title: string
  originLabel?: string
  preview?: string
}

export type BotChatSearchWorker = { key: string; chatId: string; title: string }

/** One chat a search found: `workerKeys` lists the workers that hit when the chat itself didn't. */
export type BotChatSearchMatch = { chatId: string; workerKeys: string[] | null }

/** `bots.chats.search`'s answer. */
export type BotChatSearchResult = {
  /** The matching chats in list order, each with its matching workers among its own. */
  chats: BotChatTreeChat[]
  matches: BotChatSearchMatch[]
  /** Matching chats past the limit. */
  more: number
}

/** Chats in the order given (the list's), the first `limit` that match, and how many more do. */
export function matchBotChats(
  chats: readonly BotChatSearchChat[],
  workers: readonly BotChatSearchWorker[],
  query: string,
  {
    limit = BOT_CHAT_SEARCH_LIMIT,
    contentChatIds
  }: {
    limit?: number
    /** Chats whose conversation text matched, from the host's session search index. */
    contentChatIds?: ReadonlySet<string>
  } = {}
): { matches: BotChatSearchMatch[]; more: number } {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) {
    return { matches: [], more: 0 }
  }
  const hit = (text: string | undefined): boolean =>
    text !== undefined && text.toLocaleLowerCase().includes(needle)
  const workerHits = new Map<string, string[]>()
  for (const worker of workers) {
    if (hit(worker.title)) {
      const keys = workerHits.get(worker.chatId) ?? []
      if (keys.length < BOT_CHAT_SEARCH_WORKERS_PER_CHAT) {
        keys.push(worker.key)
      }
      workerHits.set(worker.chatId, keys)
    }
  }
  const matches: BotChatSearchMatch[] = []
  let more = 0
  for (const chat of chats) {
    // A group room session is its room's, not one of the bot's chats: only its workers match.
    const own =
      !isBotGroupMemberSession(chat.chatId) &&
      (hit(chat.title) ||
        hit(chat.originLabel) ||
        hit(chat.preview) ||
        (contentChatIds?.has(chat.chatId) ?? false))
    const keys = workerHits.get(chat.chatId)
    if (!own && !keys) {
      continue
    }
    if (matches.length < limit) {
      matches.push({ chatId: chat.chatId, workerKeys: own ? null : (keys ?? null) })
    } else {
      more += 1
    }
  }
  return { matches, more }
}
