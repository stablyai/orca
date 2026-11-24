import type { GitHistoryRefs } from './git-history-types'
import { validateHistoryRefs } from './git-history-revisions'

export function normalizeGitGraphFilters(value: unknown): Record<string, GitHistoryRefs> {
  const filters: Record<string, GitHistoryRefs> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return filters
  }
  for (const [key, refs] of Object.entries(value)) {
    if (refs === 'all' || refs === 'head') {
      filters[key] = refs
    } else if (Array.isArray(refs) && refs.every((ref): ref is string => typeof ref === 'string')) {
      try {
        validateHistoryRefs(refs)
        filters[key] = [...new Set(refs)].sort()
      } catch {
        /* Discard an invalid saved choice. */
      }
    }
  }
  return filters
}
