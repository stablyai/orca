import type { BeadsIssueDetails } from '../../../../shared/beads-types'
import type { BeadsIssueFetchPlan } from '../../../../shared/beads-task-query'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { BeadsListIssuesResult } from '@/runtime/runtime-beads-client'

export const BEADS_CACHE_TTL = 60_000
export const MAX_BEADS_LIST_CACHE_ENTRIES = 100
export const MAX_BEADS_DETAILS_CACHE_ENTRIES = 30

export type BeadsListErrorKind = 'missing-task-source-capability' | 'load-failed'

export type BeadsListCacheEntry = {
  /** Last good list+status; kept through refresh failures so the list doesn't blank. */
  data: BeadsListIssuesResult | null
  fetchedAt: number
  error?: BeadsListErrorKind
}

export type BeadsIssueDetailsCacheEntry = {
  details: BeadsIssueDetails | null
  fetchedAt: number
  /** Read-generation stamp; any beads mutation/invalidation stales the entry by bumping the generation. */
  generation: number
}

/** Cache/subscription key for one repo-scoped beads list; TaskPage selects `beadsListCache[key]`. */
export function beadsIssueListCacheKey(
  sourceContext: TaskSourceContext,
  plan: BeadsIssueFetchPlan
): string {
  return `${getTaskSourceCacheScope(sourceContext)}::${plan.statusScope}:a=${plan.assignee ?? ''}`
}

/** Cache/subscription key for one issue's detail view; the dialog selects `beadsIssueDetailsCache[key]`. */
export function beadsIssueDetailsCacheKey(sourceContext: TaskSourceContext, id: string): string {
  return `${getTaskSourceCacheScope(sourceContext)}::issue:${id}`
}

export function requireBeadsRepoId(sourceContext: TaskSourceContext): string {
  const repoId = sourceContext.repoId
  if (!repoId) {
    throw new Error('Beads is repo-backed; the task source context must carry a repoId.')
  }
  return repoId
}

// Why: invalidation token — bumping it strands in-flight reads so their late results can't repopulate a cleared cache.
let beadsReadGeneration = 0

export function currentBeadsReadGeneration(): number {
  return beadsReadGeneration
}

export function bumpBeadsReadGeneration(): void {
  beadsReadGeneration += 1
}

export function evictOldestBeadsEntries<T extends { fetchedAt: number }>(
  cache: Record<string, T>,
  maxEntries: number
): Record<string, T> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, T> = {}
  for (const key of sorted.slice(sorted.length - maxEntries)) {
    pruned[key] = cache[key]
  }
  return pruned
}

/** Drops every entry under the source context's cache-scope prefix (all entries when the context is absent). */
export function dropBeadsScopeEntries<T>(
  cache: Record<string, T>,
  sourceContext: TaskSourceContext | null | undefined
): Record<string, T> {
  if (!sourceContext) {
    return {}
  }
  const prefix = `${getTaskSourceCacheScope(sourceContext)}::`
  const kept: Record<string, T> = {}
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) {
      kept[key] = entry
    }
  }
  return kept
}
