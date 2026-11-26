// Whose chats a bot's Chats tab and its sidebar rows show: one pick per bot, so both follow it.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import {
  botChatPickHas,
  botItemsPersonPick,
  botPickedOther,
  type BotChatPersonPick
} from '../../../../shared/bots/bot-chat-people'
import { useBotItemsPeople, type BotPersonPickLabelled } from './BotPersonPickItems'
import type { BotChatTree } from './use-bot-chat-tree'

const picks = new Map<string, BotChatPersonPick>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type BotChatsPersonPick = {
  /** The viewer first; null for a bot shared with no one. */
  people: BotPersonPickLabelled[] | null
  pick: BotChatPersonPick
  /** The picked person when it is someone other than the viewer. */
  other: BotPersonPickLabelled | null
  setPick: (pick: BotChatPersonPick) => void
}

/** The viewer's own until another pick, as Items opens; a pick whose person is gone falls back. */
export function useBotChatsPersonPick(bot: Bot): BotChatsPersonPick {
  const key = botRefKey(bot)
  const people = useBotItemsPeople(bot)
  const picked = useSyncExternalStore(subscribe, () => picks.get(key) ?? null)
  const pick = botItemsPersonPick(people, picked)
  const setPick = useCallback(
    (next: BotChatPersonPick) => {
      picks.set(key, next)
      listeners.forEach((listener) => listener())
    },
    [key]
  )
  return { people, pick, other: botPickedOther(pick, people), setPick }
}

/** The tree with only the picked person's chats, and the workspaces under them. */
export function useBotChatTreeOfPick(tree: BotChatTree, pick: BotChatPersonPick): BotChatTree {
  return useMemo(() => {
    if (pick.kind === 'everyone') {
      return tree
    }
    const chats = tree.chats.filter((chat) => botChatPickHas(pick, chat))
    const kept = new Set(chats.map((chat) => chat.chatId))
    const workspaceChats = Object.fromEntries(
      Object.entries(tree.workspaceChats).filter(([, chatId]) => kept.has(chatId))
    )
    return { ...tree, chats, workspaceChats }
  }, [tree, pick])
}
