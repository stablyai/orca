// The Needs you count (`botNeedsYouCount`) as the surfaces that already read it publish it: the bot's
// panel, its Items tab badge and the panel toggle. The sidebar row and Cmd+J read it from here, so they
// start no host read of their own; with no publisher for a bot they count from what they hold.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'

const published = new Map<string, Map<symbol, number>>()
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The bot's published count, or null while nothing that reads it is mounted. */
export function readPublishedBotNeedsYou(key: string): number | null {
  const counts = published.get(key)
  if (!counts) {
    return null
  }
  // Publishers read the same sources, so any of them speaks for the rest.
  const [count] = counts.values()
  return count ?? null
}

/** Publishes `count` for the bot while mounted; null (no bot) publishes nothing. */
export function usePublishBotNeedsYou(bot: BotRef | null, count: number): void {
  const key = bot ? botRefKey(bot) : null
  useEffect(() => {
    if (!key) {
      return undefined
    }
    const token = Symbol(key)
    const counts = published.get(key) ?? new Map<symbol, number>()
    published.set(key, counts)
    counts.set(token, count)
    emit()
    return () => {
      counts.delete(token)
      if (counts.size === 0) {
        published.delete(key)
      }
      emit()
    }
  }, [key, count])
}

/** Several bots' published counts, summed: a group's Items tab badge, which its open panel publishes. */
export function usePublishedBotsNeedsYou(bots: readonly BotRef[]): number {
  const keys = bots.map(botRefKey).join('\n')
  const read = useCallback(
    (): number =>
      keys === ''
        ? 0
        : keys.split('\n').reduce((sum, key) => sum + (readPublishedBotNeedsYou(key) ?? 0), 0),
    [keys]
  )
  return useSyncExternalStore(subscribe, read, read)
}

/** The bot's published count; each row re-renders only when its own number changes. */
export function usePublishedBotNeedsYou(bot: BotRef): number | null {
  const key = botRefKey(bot)
  const read = (): number | null => readPublishedBotNeedsYou(key)
  return useSyncExternalStore(subscribe, read, read)
}
