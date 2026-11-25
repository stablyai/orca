import { captureBotRecordOwner } from '../automations/hosts/bot-automation-row-owner'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BOT_WORK_KINDS } from '../../../../shared/bots/bot-change-scope'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import {
  botOwnChatTree,
  orderBotChats,
  type BotChatTreeChat,
  type BotChatTreeRead,
  type BotChatTreeWorker
} from '../../../../shared/bots/bot-chat-tree'
import { botChatTreeCursor, mergeShownFinished } from '../../../../shared/bots/bot-chat-tree-model'
import { createBotHostRead, useBotHostRead, type BotHostReadState } from './use-bot-host-read'
import { useBotHostReadState } from './use-bot-host-read-state'
import { onBotsChanged } from '@/lib/bots-changed-window-event'

/** Work changes come in bursts, so reads start at most this often. */
const CHAT_TREE_MIN_READ_GAP_MS = 1000

// One read per bot for the panel and the sidebar alike; kept, so unfolding a bot again shows its chats at once.
const chatTreeRead = createBotHostRead<BotChatTreeRead>(
  'bots.chatTree',
  (result: BotChatTreeRead) => result,
  'Failed to read bot chats:',
  BOT_WORK_KINDS,
  CHAT_TREE_MIN_READ_GAP_MS,
  true,
  undefined,
  (bot) => {
    const qualify = captureBotRecordOwner(bot)
    return (read) => ({
      ...read,
      chats: read.chats.map((chat) =>
        qualify({
          ...chat,
          running: chat.running.map(qualify),
          finished: chat.finished.map(qualify)
        })
      )
    })
  }
)

export type BotChatTree = {
  /** Home first, then waiting on you, replying, newest; closed last. */
  chats: BotChatTreeChat[]
  /** Each of the bot's workspaces by the chat it sits under. */
  workspaceChats: Record<string, string>
  /** Reads the chat's next 8 finished workers onto its list. */
  loadMore: (chatId: string) => void
  /** Whether the chats have been read. */
  state: BotHostReadState
  /** The chats are the last good read after a refresh failed. */
  refreshFailed: boolean
  /** A read landed since this surface opened: the chats aren't only the kept ones. */
  landed: boolean
  /** The host said the bot's work changed and no read started since has landed: the chats may be out of date. */
  changeUnread: boolean
  retry: () => void
}

/** Finished workers shown past the host's newest, by chat; kept per surface, so each steps on its own. */
type LoadedPages = { botKey: string; byChat: Record<string, BotChatTreeWorker[]> }

const NO_WORKSPACES: Record<string, string> = {}
const NO_PAGES: LoadedPages['byChat'] = {}

type ChangeNotices = {
  unread: boolean
  /** Bumped by each notice, so only the newest notice's read clears `unread`. */
  latest: number
  /** A notice came while the window was hidden; its read is asked for once it shows. */
  missed: boolean
  /** A settle is waiting on a read. */
  settling: boolean
  listeners: Set<() => void>
  /** Asks again for a read covering the newest notice: when a reader attaches while one is unread. */
  settle: () => void
  stop: () => void
}

/** Per bot, shared by every surface reading its chats (sidebar, Chats panel), for as long as any does:
 *  set by each change notice, cleared only when a read that started after the newest notice lands. */
const changeNoticesByBot = new Map<string, ChangeNotices>()

function watchChangeNotices(bot: BotRef, key: string): ChangeNotices {
  const notices: ChangeNotices = {
    unread: false,
    latest: 0,
    missed: false,
    settling: false,
    listeners: new Set(),
    settle: () => {},
    stop: () => {}
  }
  const tell = (): void => notices.listeners.forEach((listener) => listener())
  // Unchanged answers notify no reader, so this waits on the read itself, not on the shown value. A read
  // that fails or never comes leaves `unread` set until a later covering read lands: the next notice's,
  // the window showing again, or a reader attaching (its own first read, shared, not an extra one).
  const settle = (): void => {
    const notice = notices.latest
    notices.settling = true
    void chatTreeRead.requestSettled(bot).then((settled) => {
      if (changeNoticesByBot.get(key) !== notices) {
        return
      }
      notices.settling = false
      if (settled.ok && notice === notices.latest) {
        notices.unread = false
        tell()
      }
    })
  }
  notices.settle = settle
  const onChanged = (): void => {
    notices.latest += 1
    if (!notices.unread) {
      notices.unread = true
      tell()
    }
    // A hidden window reads once it shows again, as the chat read itself does.
    if (document.visibilityState === 'visible') {
      settle()
    } else {
      notices.missed = true
    }
  }
  const onVisible = (): void => {
    if (
      (notices.missed || (notices.unread && !notices.settling)) &&
      document.visibilityState === 'visible'
    ) {
      notices.missed = false
      settle()
    }
  }
  const stopListening = onBotsChanged(onChanged, bot.hostId, {
    botId: bot.id,
    kinds: chatTreeRead.kinds
  })
  document.addEventListener('visibilitychange', onVisible)
  notices.stop = () => {
    stopListening()
    document.removeEventListener('visibilitychange', onVisible)
  }
  return notices
}

/** Whether the host said the bot's work changed and no read started since has landed. */
function useChangeUnread(bot: Bot | null): boolean {
  const hostId = bot?.hostId ?? null
  const botId = bot?.id ?? null
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!hostId || !botId) {
        return () => {}
      }
      const ref = { hostId, id: botId }
      const key = botRefKey(ref)
      let notices = changeNoticesByBot.get(key)
      if (!notices) {
        notices = watchChangeNotices(ref, key)
        changeNoticesByBot.set(key, notices)
      }
      const watched = notices
      watched.listeners.add(listener)
      // A reader attaching starts its own read; an unread notice with no settle waiting rides on it.
      if (watched.unread && !watched.settling && document.visibilityState === 'visible') {
        watched.settle()
      }
      return () => {
        watched.listeners.delete(listener)
        if (watched.listeners.size === 0 && changeNoticesByBot.get(key) === watched) {
          watched.stop()
          changeNoticesByBot.delete(key)
        }
      }
    },
    [hostId, botId]
  )
  const getUnread = useCallback(
    () =>
      hostId && botId
        ? (changeNoticesByBot.get(botRefKey({ hostId, id: botId }))?.unread ?? false)
        : false,
    [hostId, botId]
  )
  return useSyncExternalStore(subscribe, getUnread, getUnread)
}

/** The bot's chats with their workers, from its host (a paired server's too); empty until read.
 *  Pass null to read nothing, for a surface that shows no chats (a folded bot, say). */
export function useBotChatTree(bot: Bot | null): BotChatTree {
  const read = useBotHostRead(chatTreeRead, bot)
  const { state, refreshFailed, landed, retry } = useBotHostReadState(chatTreeRead, bot)
  const changeUnread = useChangeUnread(bot)
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
    const entries = read?.chats ?? []
    const runningKeys = Object.keys(byChat).length
      ? new Set(entries.flatMap((chat) => chat.running.map((worker) => worker.key)))
      : undefined
    return orderBotChats(
      entries.map((chat) => {
        const loaded = byChat[chat.chatId]
        const { turnDone } = chat
        return {
          ...chat,
          // The host can't see this client's acks, so unread is read against them here.
          unread: turnDone ? (ackOf.get(turnDone.paneKey) ?? 0) < turnDone.at : chat.unread,
          ...(loaded
            ? {
                finished: mergeShownFinished(chat.finished, loaded, runningKeys)
              }
            : {})
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
      const qualify = captureBotRecordOwner({ hostId, id: botId })
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
            return {
              botKey,
              byChat: { ...base, [chatId]: [...shown, ...page.finished.map(qualify)] }
            }
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
    refreshFailed,
    landed,
    changeUnread,
    retry
  }
}

/** The bot's chats as its own lists show them (Chats tab, sidebar, chat picker), group room sessions'
 *  workers under Home Chat (`botOwnChatTree`). What needs the owner reads `useBotChatTree`. */
export function useBotOwnChatTree(bot: Bot | null): BotChatTree {
  const tree = useBotChatTree(bot)
  const own = useMemo(
    () => botOwnChatTree({ chats: tree.chats, workspaceChats: tree.workspaceChats }),
    [tree.chats, tree.workspaceChats]
  )
  return own.chats === tree.chats ? tree : { ...tree, ...own }
}
