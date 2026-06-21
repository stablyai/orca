import type { Repo } from '../../../../shared/types'
import { normalizeSettingsSearchQuery } from './settings-search'

export function matchesRepositoryIdentitySearch(query: string, repo: Repo): boolean {
  const normalizedQuery = normalizeSettingsSearchQuery(query)
  if (!normalizedQuery) {
    return false
  }
  return [repo.displayName, repo.path].some((value) =>
    value.toLowerCase().includes(normalizedQuery)
  )
}
