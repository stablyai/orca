// Which of a bot's panel cards its owner folded, remembered per bot and shared with the sidebar.
import { useCallback, useSyncExternalStore } from 'react'

// Items groups: the stored flag says the owner flipped the group's default.
export type BotPanelFoldId =
  | 'automations'
  | 'suggestions'
  | 'automations'
  | 'items-needs_you'
  | 'items-working'
  | 'items-planned'
  | 'items-snoozed'
  | 'items-stale'
  | 'items-closed'

const FOLDS_KEY = 'orca.bots.panelFolds'

type Folds = Record<string, readonly string[]>

// Parsed once and shared by every row, until nothing shows a fold.
let folds: Folds | null = null
// Folds storage refused, per card (bot, then card): each leads whatever storage says of that card
// alone until a write saves it.
const unsaved = new Map<string, Map<BotPanelFoldId, boolean>>()
// Each bot's subscribers: a fold re-renders only that bot's rows.
const listeners = new Map<string, Set<() => void>>()
let subscribers = 0

function parseFolds(raw: string | null): Folds {
  try {
    const stored: unknown = JSON.parse(raw ?? '{}')
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(stored).map(([botId, ids]) => [
        botId,
        Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
      ])
    )
  } catch {
    return {}
  }
}

/** What storage holds now; null when it can't be read (private windows, blocked site data). */
function readStorage(): Folds | null {
  try {
    return parseFolds(window.localStorage.getItem(FOLDS_KEY))
  } catch {
    return null
  }
}

/** Storage with each card it refused laid over it; bots with nothing folded left out. */
function withUnsaved(stored: Folds): Folds {
  const next = { ...stored }
  for (const [botId, cards] of unsaved) {
    const ids = new Set(next[botId] ?? [])
    for (const [id, folded] of cards) {
      if (folded) {
        ids.add(id)
      } else {
        ids.delete(id)
      }
    }
    next[botId] = [...ids]
  }
  for (const botId of Object.keys(next)) {
    if (next[botId].length === 0) {
      delete next[botId]
    }
  }
  return next
}

function currentFolds(): Folds {
  folds ??= withUnsaved(readStorage() ?? {})
  return folds
}

const sameIds = (a: readonly string[] = [], b: readonly string[] = []): boolean =>
  a.length === b.length && a.every((id) => b.includes(id))

/** Shows `next`, re-rendering only the bots whose folds it changes. */
function showFolds(next: Folds): void {
  const before = currentFolds()
  folds = next
  for (const botId of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (!sameIds(before[botId], next[botId])) {
      listeners.get(botId)?.forEach((listener) => listener())
    }
  }
}

function rememberFold(botId: string, id: BotPanelFoldId, open: boolean): void {
  const cards = unsaved.get(botId) ?? new Map<BotPanelFoldId, boolean>()
  cards.set(id, !open)
  unsaved.set(botId, cards)
  // Another window of this Orca may have saved its own folds since this one last read: change only
  // this card over what storage holds now. That narrows the race but doesn't close it; writes from
  // two windows aren't atomic.
  const next = withUnsaved(readStorage() ?? currentFolds())
  try {
    window.localStorage.setItem(FOLDS_KEY, JSON.stringify(next))
    unsaved.clear()
  } catch {}
  showFolds(next)
}

// Another window saved folds. Its event may be older than a write made here since, so read what
// storage holds now rather than the value the event carries.
function onStorage(event: StorageEvent): void {
  if (event.key !== FOLDS_KEY && event.key !== null) {
    return
  }
  showFolds(withUnsaved(readStorage() ?? parseFolds(event.newValue)))
}

function subscribe(botId: string, listener: () => void): () => void {
  let botListeners = listeners.get(botId)
  if (!botListeners) {
    botListeners = new Set()
    listeners.set(botId, botListeners)
  }
  botListeners.add(listener)
  subscribers += 1
  if (subscribers === 1) {
    window.addEventListener('storage', onStorage)
    // A render read storage before anything listened (or one never committed and left the read
    // behind): another window may have saved since, unheard. Read it again now that we listen.
    showFolds(withUnsaved(readStorage() ?? currentFolds()))
  }
  return () => {
    botListeners.delete(listener)
    if (botListeners.size === 0) {
      listeners.delete(botId)
    }
    subscribers -= 1
    if (subscribers === 0) {
      window.removeEventListener('storage', onStorage)
      // Unwatched, storage may change unseen: read it again on next use; refused folds stay.
      folds = null
    }
  }
}

const noSubscribe = (): (() => void) => () => {}

/** The owner folded this card on this bot; follows a fold made in its panel while shown elsewhere. */
export function useBotPanelFolded(botId: string | null, id: BotPanelFoldId): boolean {
  const subscribeBot = useCallback(
    (listener: () => void) => (botId === null ? noSubscribe() : subscribe(botId, listener)),
    [botId]
  )
  return useSyncExternalStore(
    subscribeBot,
    () => botId !== null && (currentFolds()[botId] ?? []).includes(id)
  )
}

export type BotPanelFold = { open: boolean; onOpenChange: (open: boolean) => void }

/** Open unless the owner folded it on this bot before. */
export function useBotPanelFold(botId: string, id: BotPanelFoldId): BotPanelFold {
  const open = !useBotPanelFolded(botId, id)
  return {
    open,
    onOpenChange: (next) => rememberFold(botId, id, next)
  }
}
