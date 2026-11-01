import type { BaseRefSearchResult } from '../repo-types'
import { isSmartWorkspaceSourceQueryWithinLimit } from './smart-workspace-source-query'
import type { SmartNameMode } from './smart-workspace-source-results'

export function getBranchSearchRequest({
  branchesEnabled,
  disabled,
  textOnly,
  mode,
  selectedRepoId,
  query,
  limit
}: {
  branchesEnabled?: boolean
  disabled: boolean
  textOnly: boolean
  mode: SmartNameMode
  selectedRepoId: string | null
  query: string
  limit: number
}): { repoId: string; query: string; limit: number } | null {
  if (
    branchesEnabled === false ||
    disabled ||
    textOnly ||
    !isSmartWorkspaceSourceQueryWithinLimit(query) ||
    !selectedRepoId
  ) {
    return null
  }
  const trimmedQuery = query.trim()
  const shouldSearchBranches = mode === 'branches' || (mode === 'smart' && trimmedQuery.length > 0)
  if (!shouldSearchBranches) {
    return null
  }
  return { repoId: selectedRepoId, query: trimmedQuery, limit }
}

/** Hold provider results during 200ms debounce, but clear immediately on empty input so stale rows cannot remain selectable. */
export function getVisibleHeldProviderResults<T>({
  items,
  value,
  debouncedQuery
}: {
  items: readonly T[]
  value: string
  debouncedQuery: string
}): T[] {
  if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
    return []
  }
  if (value.trim() === '' && debouncedQuery.trim() !== '') {
    return []
  }
  return items.slice()
}

export function getVisibleBranchResults({
  branches,
  mode,
  resultRepoId,
  resultQuery,
  selectedRepoId,
  value
}: {
  branches: BaseRefSearchResult[]
  mode: SmartNameMode
  resultRepoId: string | null
  resultQuery: string | null
  selectedRepoId: string | null
  value: string
}): BaseRefSearchResult[] {
  if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
    return []
  }
  if (mode !== 'branches' && mode !== 'smart') {
    return []
  }
  if (!selectedRepoId || resultRepoId !== selectedRepoId || resultQuery === null) {
    return []
  }
  const currentQuery = value.trim()
  // Retain settled rows for prefix edits during debounce; drop unrelated queries such as feat → bug.
  if (currentQuery === '') {
    return resultQuery === '' ? branches : []
  }
  if (!shouldHoldSourceResultsForQuery({ resultQuery, value: currentQuery })) {
    return []
  }
  return branches
}

/** Max |live − settled| length while still treating a prefix as "still typing". */
const SOURCE_RESULT_HOLD_MAX_DELTA = 4

/** Bound prefix-hold length delta: a settled f must not remain under a long unrelated continuation for the full debounce. */
export function shouldHoldSourceResultsForQuery({
  resultQuery,
  value
}: {
  resultQuery: string
  value: string
}): boolean {
  const currentQueryKey = value.trim().toLowerCase()
  const resultQueryKey = resultQuery.trim().toLowerCase()
  if (resultQueryKey === currentQueryKey) {
    return true
  }
  if (!currentQueryKey.startsWith(resultQueryKey) && !resultQueryKey.startsWith(currentQueryKey)) {
    return false
  }
  return Math.abs(currentQueryKey.length - resultQueryKey.length) <= SOURCE_RESULT_HOLD_MAX_DELTA
}
