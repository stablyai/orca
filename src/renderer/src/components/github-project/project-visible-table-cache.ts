import type { GitHubProjectTable } from '../../../../shared/github-project-types'

export type CachedVisibleProjectTable = {
  cacheKey: string
  table: GitHubProjectTable
}

export function getNextVisibleProjectTableCache(input: {
  currentCacheKey: string | null
  sourceTable: GitHubProjectTable | null
  slugIndexReady: boolean
  filteredTable: GitHubProjectTable | null
  previous: CachedVisibleProjectTable | null
}): CachedVisibleProjectTable | null {
  if (!input.currentCacheKey || !input.sourceTable) {
    return null
  }
  if (input.slugIndexReady && input.filteredTable) {
    return { cacheKey: input.currentCacheKey, table: input.filteredTable }
  }
  return input.previous
}

export function getVisibleProjectTable(input: {
  currentCacheKey: string | null
  slugIndexReady: boolean
  filteredTable: GitHubProjectTable | null
  cachedTable: CachedVisibleProjectTable | null
}): GitHubProjectTable | null {
  if (input.slugIndexReady || !input.currentCacheKey) {
    return input.filteredTable
  }
  return input.cachedTable?.cacheKey === input.currentCacheKey ? input.cachedTable.table : null
}
