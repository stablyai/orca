import type { GitHubProjectTable } from '../../../../shared/github-project-types'

export type CachedVisibleProjectTable = {
  cacheKey: string
  table: GitHubProjectTable
}

export function getSelectedRepoFingerprint(selectedRepoIds: ReadonlySet<string>): string {
  return JSON.stringify([...selectedRepoIds].sort())
}

export function getVisibleProjectTableCacheKey(
  currentCacheKey: string | null,
  selectedRepoFingerprint: string
): string | null {
  return currentCacheKey ? `${currentCacheKey}:selected:${selectedRepoFingerprint}` : null
}

export function getNextVisibleProjectTableCache(input: {
  currentCacheKey: string | null
  selectedRepoFingerprint: string
  sourceTable: GitHubProjectTable | null
  slugIndexReady: boolean
  filteredTable: GitHubProjectTable | null
  previous: CachedVisibleProjectTable | null
}): CachedVisibleProjectTable | null {
  const visibleCacheKey = getVisibleProjectTableCacheKey(
    input.currentCacheKey,
    input.selectedRepoFingerprint
  )
  if (!visibleCacheKey || !input.sourceTable) {
    return null
  }
  if (input.slugIndexReady && input.filteredTable) {
    return { cacheKey: visibleCacheKey, table: input.filteredTable }
  }
  return input.previous
}

export function getVisibleProjectTable(input: {
  currentCacheKey: string | null
  selectedRepoFingerprint: string
  slugIndexReady: boolean
  filteredTable: GitHubProjectTable | null
  cachedTable: CachedVisibleProjectTable | null
}): GitHubProjectTable | null {
  if (input.slugIndexReady || !input.currentCacheKey) {
    return input.filteredTable
  }
  const visibleCacheKey = getVisibleProjectTableCacheKey(
    input.currentCacheKey,
    input.selectedRepoFingerprint
  )
  return input.cachedTable?.cacheKey === visibleCacheKey ? input.cachedTable.table : null
}
