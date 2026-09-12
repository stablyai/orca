import type {
  RedmineConnectionStatus,
  RedmineListFilter
} from '../../../../../shared/redmine-types'

export const REDMINE_CACHE_TTL = 60_000 // 60s — same as Linear/GitHub revalidation TTL
export const MAX_CACHE_ENTRIES = 500

export function isFresh(
  entry: { fetchedAt: number } | undefined,
  ttl = REDMINE_CACHE_TTL
): boolean {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
}

export function redmineListCacheKey(filter: RedmineListFilter | undefined): string {
  const state = filter?.state ?? 'open'
  const scope = filter?.scope ?? 'assigned'
  const limit = filter?.limit ?? 20
  const page = filter?.page ?? 1
  return `list::${state}::${scope}::${limit}::${page}`
}

export function redmineIssueCacheKey(issueId: number): string {
  return `issue::${issueId}`
}

export function redmineStatusScopeSignature(status: RedmineConnectionStatus): string {
  return JSON.stringify({
    connected: status.connected,
    activeSiteId: status.activeSite?.id ?? null,
    selectedSiteId: status.selectedSiteId ?? null,
    error: status.error ?? null
  })
}

export const REDMINE_LIST_INVALIDATION_VERSION_CAP = 10_000
export let redmineListInvalidationToken: { scope: string; version: number } = {
  scope: '',
  version: 0
}

export function setRedmineListInvalidationToken(next: { scope: string; version: number }): void {
  redmineListInvalidationToken = next
}
