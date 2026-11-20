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
// The bot whose list showed last: showing another one starts it on its list.
let shownBot: string | null = null
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

/** The open page's row key, when it is one of `bot`'s connectors. */
export function useBotConnectorPage(bot: BotRef): string | null {
  const read = (): string | null => openPage
  const page = useSyncExternalStore(subscribe, read, read)
  const prefix = `${botRefKey(bot)}\u0000`
  useEffect(() => {
    // A page opened for this bot before it showed (a Needs you link) stays; another bot's closes.
    if (shownBot !== prefix) {
      shownBot = prefix
      if (openPage !== null && !openPage.startsWith(prefix)) {
        openBotConnectorPage(null)
      }
    }
  }, [prefix])
  return page?.startsWith(prefix) ? page : null
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
