// The Chats search on the desktop panel and the phone: the bot's host matches every chat and worker,
// asked once typing pauses.
import type * as React from 'react'
import type { BotChatTreeChat } from './bot-chat-tree'
import type { BotChatSearchResult } from './bot-chat-search'
import { botChatSearchHits, type BotChatSearchState } from './bot-chat-tree-view'

/** Typing pauses this long before the host is asked. */
export const BOT_CHAT_SEARCH_DEBOUNCE_MS = 175

export type BotChatSearchAsk = (query: string) => Promise<BotChatSearchResult>

type Answer = {
  query: string
  attempt: number
  result: BotChatSearchResult | 'failed'
}

export type BotChatSearch = BotChatSearchState & {
  /** Asks again after a failed search. */
  retry: () => void
}

/** Built with the caller's own React: desktop and the phone bundle each resolve a different copy. */
export function createBotChatSearchHook({
  useCallback,
  useEffect,
  useMemo,
  useState
}: Pick<typeof React, 'useCallback' | 'useEffect' | 'useMemo' | 'useState'>) {
  return useBotChatSearch

  /** Null with no query. `ask` must keep its identity while its bot and host do. */
  function useBotChatSearch(
    ask: BotChatSearchAsk,
    chats: readonly BotChatTreeChat[],
    query: string
  ): BotChatSearch | null {
    const trimmed = query.trim()
    const [answer, setAnswer] = useState<Answer | null>(null)
    const [attempt, setAttempt] = useState(0)
    const retry = useCallback(() => setAttempt((count) => count + 1), [])
    // A chat gone or new since the last answer (a Delete chat, say) is asked again.
    const chatIds = chats.map((chat) => chat.chatId).join('\n')
    useEffect(() => {
      if (!trimmed) {
        return
      }
      let current = true
      const timer = setTimeout(() => {
        ask(trimmed)
          .catch(() => 'failed' as const)
          .then((result) => {
            if (current) {
              setAnswer({ query: trimmed, attempt, result })
            }
          })
      }, BOT_CHAT_SEARCH_DEBOUNCE_MS)
      return () => {
        current = false
        clearTimeout(timer)
      }
    }, [ask, trimmed, attempt, chatIds])

    return useMemo(() => {
      if (!trimmed) {
        return null
      }
      const pending = answer?.query !== trimmed || answer.attempt !== attempt
      if (answer?.result === 'failed') {
        return { hits: [], more: 0, pending, failed: !pending, retry }
      }
      // The last answer stays up while the next is asked, so rows don't blank between keys.
      return {
        hits: answer
          ? botChatSearchHits(
              answer.result,
              chats.find((chat) => chat.origin === 'home' && !chat.closed) ?? null
            )
          : [],
        more: answer?.result.more ?? 0,
        pending,
        failed: false,
        retry
      }
    }, [trimmed, answer, attempt, chats, retry])
  }
}
