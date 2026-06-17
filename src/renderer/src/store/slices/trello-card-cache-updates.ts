import type { TrelloCard } from '../../../../shared/trello-types'
import type { CacheEntry } from './github'

/**
 * Applies an optimistic patch to every card/search cache entry whose card
 * matches `cardId`. Card detail entries get `fetchedAt: 0` so a forced
 * refresh (or TTL expiry) will re-fetch from the server. Search/list
 * entries get the patched card spliced into the existing array.
 *
 * Returns a partial state to merge, or `{}` if no entry matched.
 *
 * Why this is a function (not inlined into the reducer): the reducer in
 * trello.ts is already large; isolating the loop lets the store file
 * stay under the line budget and keeps the patch logic independently
 * testable.
 */
export function applyPatchToTrelloCacheEntries(
  cardId: string,
  patch: Partial<TrelloCard>,
  cardCache: Record<string, CacheEntry<TrelloCard>>,
  searchCache: Record<string, CacheEntry<TrelloCard[]>>
): {
  trelloCardCache?: Record<string, CacheEntry<TrelloCard>>
  trelloSearchCache?: Record<string, CacheEntry<TrelloCard[]>>
} {
  let changed = false

  const nextCardCache = { ...cardCache }
  for (const [key, entry] of Object.entries(nextCardCache)) {
    if (entry?.data?.id !== cardId) {
      continue
    }
    // Stale fetchedAt ensures a force-refresh or TTL check will re-fetch
    nextCardCache[key] = { ...entry, data: { ...entry.data, ...patch }, fetchedAt: 0 }
    changed = true
  }

  const nextSearchCache = { ...searchCache }
  for (const key of Object.keys(nextSearchCache)) {
    const entry = nextSearchCache[key]
    if (!entry?.data) {
      continue
    }
    const index = entry.data.findIndex((card) => card.id === cardId)
    if (index === -1) {
      continue
    }
    const updatedItems = [...entry.data]
    updatedItems[index] = { ...updatedItems[index], ...patch }
    nextSearchCache[key] = { ...entry, data: updatedItems }
    changed = true
  }

  return changed ? { trelloCardCache: nextCardCache, trelloSearchCache: nextSearchCache } : {}
}
