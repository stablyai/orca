import type {
  TrelloBoard,
  TrelloCard,
  TrelloComment,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from '../../../../shared/trello-types'
import type { CacheEntry } from './github'

export const CACHE_TTL = 60_000
export const MAX_CACHE_ENTRIES = 500

export function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

export function evictStaleEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const key of sorted.slice(sorted.length - maxEntries)) {
    pruned[key] = cache[key]
  }
  return pruned
}

export function looksLikeAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /authenticat|unauthorized|forbidden|401|403/i.test(msg)
}

// ─── Inflight request dedup maps ─────────────────────────────────────
// Dynamic runtime collections with .clear() — Map is the correct type.
export const inflightCardRequests = new Map<string, Promise<TrelloCard | null>>()
export const inflightSearchRequests = new Map<string, Promise<TrelloCard[]>>()
export const inflightListRequests = new Map<string, Promise<TrelloCard[]>>()

export function clearTrelloInflight(): void {
  inflightCardRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

// ─── Default state factory ───────────────────────────────────────────
/**
 * Produces the initial (disconnected) Trello store slice fields.
 * Used both at store creation and when resetting Trello state on
 * runtime switch or disconnect.
 *
 * Why this is a function and not an object literal: callers that
 * call it at module scope would share one mutable object, while
 * callers that call it inside a reducer get a fresh snapshot.
 */
export function createInitialTrelloState() {
  return {
    trelloCacheGeneration: 0,
    trelloStatus: { connected: false, viewer: null } as const,
    trelloStatusChecked: false,
    trelloCardCache: {} as Record<string, CacheEntry<TrelloCard>>,
    trelloSearchCache: {} as Record<string, CacheEntry<TrelloCard[]>>,
    trelloBoardsCache: null as TrelloBoard[] | null,
    trelloListsCache: {} as Record<string, TrelloList[]>,
    trelloCommentsCache: {} as Record<string, CacheEntry<TrelloComment[]>>,
    trelloBoardMembersCache: {} as Record<string, TrelloMember[]>,
    trelloBoardLabelsCache: {} as Record<string, TrelloLabel[]>
  }
}
