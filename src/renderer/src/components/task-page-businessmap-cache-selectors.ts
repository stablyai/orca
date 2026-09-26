import type { BusinessmapCard } from '../../../shared/businessmap-types'
import type { CacheEntry } from '@/store/github/cache-model'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'

type BusinessmapCardCache = Record<string, CacheEntry<BusinessmapCard>>
type BusinessmapSearchCache = Record<string, CacheEntry<BusinessmapCard[]>>

export type TaskPageBusinessmapCardLookupOptions = {
  sourceContext?: TaskSourceContext | null
}

// Why: card ids are only unique within a site/source, so detail lookup
// must not borrow a same-id card cached for another host/account.
export function findTaskPageBusinessmapCard(
  cardCache: BusinessmapCardCache,
  searchCache: BusinessmapSearchCache,
  cardId: number | null,
  options: TaskPageBusinessmapCardLookupOptions = {}
): BusinessmapCard | null {
  if (cardId === null || cardId === undefined) {
    return null
  }
  const sourceScope =
    options.sourceContext?.provider === 'businessmap'
      ? getTaskSourceCacheScope(options.sourceContext)
      : null
  const matchesLookup = (cacheKey: string, card: BusinessmapCard | null | undefined): boolean => {
    if (!card || card.id !== cardId) {
      return false
    }
    return sourceScope === null || cacheKey.startsWith(`${sourceScope}::`)
  }

  for (const [cacheKey, entry] of Object.entries(cardCache)) {
    if (matchesLookup(cacheKey, entry?.data)) {
      return entry.data
    }
  }

  for (const [cacheKey, entry] of Object.entries(searchCache)) {
    const found = entry?.data?.find((card) => matchesLookup(cacheKey, card))
    if (found) {
      return found
    }
  }

  return null
}
