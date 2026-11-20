// Which connector's own page the Connectors list shows in its place, kept for the session: leaving
// the tab and coming back finds it open; another bot's list starts on the list.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore
} from 'react'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'

let openPage: string | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A connector row's key: its host, bot and connector entry. */
export function botConnectorRowKey(bot: BotRef, entryKey: string): string {
  return `${botRefKey(bot)}\u0000${entryKey}`
}

/** Shows the connector's page in place of its bot's list (null: the list). */
export function openBotConnectorPage(rowKey: string | null): void {
  if (openPage === rowKey) {
    return
  }
  openPage = rowKey
  listeners.forEach((listener) => listener())
}

export function forgetBotConnectorPage(rowKey: string): void {
  if (openPage === rowKey) {
    openBotConnectorPage(null)
  }
}

/** Changing bots closes the previous bot's page even while another tab is visible. */
export function useResetOtherBotConnectorPage(bot: BotRef | null): void {
  const prefix = bot ? botConnectorRowKey(bot, '') : null
  useEffect(() => {
    if (prefix && openPage && !openPage.startsWith(prefix)) {
      openBotConnectorPage(null)
    }
  }, [prefix])
}

const readPage = (): string | null => openPage

/** An absent row is only a removal after its service has answered. */
export function useBotConnectorPage(
  bot: BotRef,
  entries: readonly { key: string }[],
  unresolved: readonly string[]
): string | null {
  useResetOtherBotConnectorPage(bot)
  const selected = useSyncExternalStore(subscribe, readPage, readPage)
  const prefix = botConnectorRowKey(bot, '')
  const key = selected?.startsWith(prefix) ? selected.slice(prefix.length) : null
  const page = key && entries.some((entry) => entry.key === key) ? selected : null
  const removed =
    key && page === null && !unresolved.includes(key.split(':', 1)[0]) ? selected : null
  useEffect(() => {
    if (removed) {
      forgetBotConnectorPage(removed)
    }
  }, [removed])
  return page
}

/** The connector a row stands for; none for rows that fold in place, e.g. Tools. */
export const BotConnectorRowKey = createContext<string | null>(null)

/**
 * The connector list's open page (null: the list shows); undefined outside a connector list, where
 * rows fold open in place.
 */
export const BotConnectorPageShown = createContext<string | null | undefined>(undefined)

/** True inside a connector's own page, where its body groups into captioned cards. */
export const BotConnectorPageSections = createContext(false)

/** Whether a body renders on its connector's own page. */
export function useBotConnectorPaged(): boolean {
  return useContext(BotConnectorPageSections)
}

/** A folding row's open state: `defaultOpen` at first, and open again whenever it turns true. */
export function useBotRowOpen(
  defaultOpen: boolean
): readonly [boolean, (open: boolean | ((open: boolean) => boolean)) => void] {
  const [row, setRow] = useState({ open: defaultOpen, defaultOpen })
  if (defaultOpen !== row.defaultOpen) {
    setRow({ open: defaultOpen || row.open, defaultOpen })
  }
  const setOpen = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setRow((prev) => ({ ...prev, open: typeof next === 'function' ? next(prev.open) : next }))
  }, [])
  return [row.open, setOpen] as const
}
