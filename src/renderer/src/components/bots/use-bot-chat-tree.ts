import { useCallback, useMemo, useRef, useState } from 'react'
import { BOT_WORK_KINDS } from '../../../../shared/bots/bot-change-scope'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { botRefKey, callBotRpc } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import {
  orderBotChats,
  type BotChatTreeChat,
  type BotChatTreeRead,
  type BotChatTreeWorker
} from '../../../../shared/bots/bot-chat-tree'
import { botChatTreeCursor, mergeShownFinished } from '../../../../shared/bots/bot-chat-tree-model'
import {
  createBotHostRead,
  useBotHostRead,
  useBotHostReadState,
  type BotHostReadState
} from './use-bot-host-read'

/** Work changes come in bursts, so reads start at most this often. */
const CHAT_TREE_MIN_READ_GAP_MS = 1000

// One read per bot for the panel and the sidebar alike; kept, so unfolding a bot again shows its chats at once.
const chatTreeRead = createBotHostRead<BotChatTreeRead>(
  'bots.chatTree',
  (result: BotChatTreeRead) => result,
  'Failed to read bot chats:',
  BOT_WORK_KINDS,
  CHAT_TREE_MIN_READ_GAP_MS,
  true
)

export type BotChatTree = {
  /** Home first, then waiting on you, replying, newest; closed last. */
  chats: BotChatTreeChat[]
  /** Each of the bot's workspaces by the chat it sits under. */
  workspaceChats: Record<string, string>
  /** Reads the chat's next 8 finished workers onto its list. */
  loadMore: (chatId: string) => void
  /** Whether the chats have been read; an older host without the read stays `unsupported`. */
  state: BotHostReadState
  retry: () => void
}

/** Finished workers shown past the host's newest, by chat; kept per surface, so each steps on its own. */
type LoadedPages = { botKey: string; byChat: Record<string, BotChatTreeWorker[]> }

const NO_WORKSPACES: Record<string, string> = {}
const NO_PAGES: LoadedPages['byChat'] = {}

/** The bot's chats with their workers, from its host (a paired server's too); empty until read.
 *  Pass null to read nothing, for a surface that shows no chats (a folded bot, say). */
export function useBotChatTree(bot: Bot | null): BotChatTree {
  const read = useBotHostRead(chatTreeRead, bot)
  const { state, retry } = useBotHostReadState(chatTreeRead, bot)
  // Only this bot's finished turns' acks, so focusing a pane elsewhere doesn't re-render it.
  const turnPanes = useMemo(
    () => (read?.chats ?? []).flatMap((chat) => (chat.turnDone ? [chat.turnDone.paneKey] : [])),
    [read]
  )
  const acks = useAppStore(
    useShallow((s) => turnPanes.map((paneKey) => s.acknowledgedAgentsByPaneKey[paneKey] ?? 0))
  )
  const botKey = bot ? botRefKey(bot) : ''
  const [pages, setPages] = useState<LoadedPages>({ botKey, byChat: {} })
  const byChat = pages.botKey === botKey ? pages.byChat : NO_PAGES

  const chats = useMemo(() => {
    const ackOf = new Map(turnPanes.map((paneKey, index) => [paneKey, acks[index] ?? 0]))
    return orderBotChats(
      (read?.chats ?? []).map((chat) => {
        const loaded = byChat[chat.chatId]
        const { turnDone } = chat
        return {
          ...chat,
          // The host can't see this client's acks, so unread is read against them here.
          unread: turnDone ? (ackOf.get(turnDone.paneKey) ?? 0) < turnDone.at : chat.unread,
          ...(loaded ? { finished: mergeShownFinished(chat.finished, loaded) } : {})
        }
      })
    )
  }, [read, byChat, turnPanes, acks])
  const loading = useRef(new Set<string>())

  const hostId = bot?.hostId ?? null
  const botId = bot?.id ?? null
  const loadMore = useCallback(
    (chatId: string) => {
      if (!hostId || !botId || loading.current.has(chatId)) {
        return
      }
      const shown = chats.find((chat) => chat.chatId === chatId)?.finished ?? []
      const last = shown.at(-1)
      loading.current.add(chatId)
      void callBotRpc<BotChatTreeRead>({ hostId }, 'bots.chatTree', {
        botId,
        chatId,
        ...(last ? { finishedAfter: botChatTreeCursor(last) } : {})
      })
        .then(({ chats: [page] }) => {
          if (!page) {
            return
          }
          setPages((current) => {
            const base = current.botKey === botKey ? current.byChat : {}
            // What was on screen stays, so a worker finishing between pages never drops one.
            return { botKey, byChat: { ...base, [chatId]: [...shown, ...page.finished] } }
          })
        })
        .catch((error: unknown) => console.error('Failed to read more of a bot chat:', error))
        .finally(() => loading.current.delete(chatId))
    },
    [hostId, botId, botKey, chats]
  )

  return {
    chats,
    workspaceChats: read?.workspaceChats ?? NO_WORKSPACES,
    loadMore,
    state,
    retry
  }
}
