import type { CacheEntry } from '../../github/cache-model'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearWorkspace,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../../../../shared/linear/workspace-types'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import { linearIssueAttributeFilterSignature } from '../../../../../shared/linear/issue-attribute-filter'

export const CACHE_TTL = 60_000 // 60s — same as GitHub work-items revalidation TTL
export const TEAM_CACHE_TTL = 10 * 60_000 // Teams change rarely and block visible Linear rows.
export const MAX_CACHE_ENTRIES = 500

export function isFresh<T>(
  entry: CacheEntry<T> | undefined,
  ttl = CACHE_TTL
): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
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
  return /authenticat|unauthorized|401/i.test(msg)
}

export function workspaceErrorType(error: unknown): LinearWorkspaceError['type'] {
  const record = error as { name?: string; message?: string; status?: number; response?: unknown }
  const message = record.message ?? String(error)
  const status =
    typeof record.status === 'number'
      ? record.status
      : typeof (record.response as { status?: unknown } | undefined)?.status === 'number'
        ? ((record.response as { status: number }).status as number)
        : undefined
  if (looksLikeAuthError(error)) {
    return 'auth'
  }
  if (status === 429 || /rate/i.test(record.name ?? '')) {
    return 'rate_limited'
  }
  if ((typeof status === 'number' && status >= 500) || /network/i.test(record.name ?? message)) {
    return 'network'
  }
  return 'unknown'
}

export function workspaceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function getSelectedWorkspaceId(
  status: LinearConnectionStatus
): LinearWorkspaceSelection | null {
  return status.selectedWorkspaceId ?? status.activeWorkspaceId ?? null
}

export function linearSearchCacheKey(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  query: string,
  limit: number
): string {
  return `${workspaceId ?? 'default'}::search::${query}::${limit}`
}

export function linearListCacheKey(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  filter: 'assigned' | 'created' | 'all' | 'completed',
  limit: number,
  attributeFilter?: LinearIssueAttributeFilter | null
): string {
  const attributeSignature = linearIssueAttributeFilterSignature(attributeFilter)
  return `${workspaceId ?? 'default'}::list::${filter}::${limit}::${attributeSignature}`
}

export const LINEAR_LIST_INVALIDATION_VERSION_CAP = 10_000
export let linearListInvalidationToken: { scope: string; version: number } = {
  scope: '',
  version: 0
}

export function setLinearListInvalidationToken(next: { scope: string; version: number }): void {
  linearListInvalidationToken = next
}

export function linearTeamsCacheKey(
  workspaceId: LinearWorkspaceSelection | null | undefined
): string {
  return `${workspaceId ?? 'default'}::teams`
}

function linearWorkspaceSignature(workspace: LinearWorkspace): string {
  return [
    workspace.id,
    workspace.organizationId,
    workspace.organizationName,
    workspace.organizationUrlKey ?? '',
    workspace.displayName,
    workspace.email ?? '',
    workspace.credentialRevision ?? 0
  ].join('\u001f')
}

/** Cache-invalidation key: broader than `linearWorkspaceScopeSignature`, hashes full viewer and workspace metadata. */
export function linearStatusScopeSignature(status: LinearConnectionStatus): string {
  return JSON.stringify({
    connected: status.connected,
    credentialError: status.credentialError ?? null,
    activeWorkspaceId: status.activeWorkspaceId ?? null,
    selectedWorkspaceId: getSelectedWorkspaceId(status),
    viewer: status.viewer
      ? [
          status.viewer.organizationId ?? '',
          status.viewer.organizationName,
          status.viewer.organizationUrlKey ?? '',
          status.viewer.displayName,
          status.viewer.email ?? ''
        ]
      : null,
    workspaces: (status.workspaces ?? []).map(linearWorkspaceSignature)
  })
}

export function shouldRefreshStatusAfterRead(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  status: LinearConnectionStatus
): boolean {
  // Why: 'all' reads can hide per-workspace decrypt failures, and a visible
  // credential error may have been cleared by a successful credential read.
  return workspaceId === 'all' || status.credentialError !== undefined
}

export function linearCollectionCacheKey(
  workspaceId: LinearWorkspaceSelection | null | undefined,
  mode: string,
  ...parts: (string | number | null | undefined)[]
): string {
  return [workspaceId ?? 'default', mode, ...parts.map((part) => part ?? '')].join('::')
}

export function emptyLinearCollection<T>(): LinearCollectionResult<T> {
  return { items: [] }
}

export function collectionWithWorkspaceError<T>(
  fallback: LinearCollectionResult<T>,
  workspaceId: string,
  error: unknown
): LinearCollectionResult<T> {
  const existingErrors = (fallback.errors ?? []).filter((item) => item.workspaceId !== workspaceId)
  return {
    ...fallback,
    errors: [
      ...existingErrors,
      {
        workspaceId,
        type: workspaceErrorType(error),
        message: workspaceErrorMessage(error) || 'Linear request failed.'
      }
    ]
  }
}

export function largestCachedCollectionBelowLimit<T>(
  cache: Record<string, CacheEntry<LinearCollectionResult<T>>>,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  mode: string,
  scopeId: string,
  limit: number
): LinearCollectionResult<T> | null {
  const keyPrefix = `${linearCollectionCacheKey(workspaceId, mode, scopeId)}::`
  let best: { limit: number; data: LinearCollectionResult<T> } | null = null
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry?.data || !key.startsWith(keyPrefix)) {
      continue
    }
    const cachedLimit = Number(key.slice(keyPrefix.length))
    if (!Number.isFinite(cachedLimit) || cachedLimit >= limit) {
      continue
    }
    if (!best || cachedLimit > best.limit) {
      best = { limit: cachedLimit, data: entry.data }
    }
  }
  return best?.data ?? null
}

export function patchLinearIssueCollectionCache(
  cache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>,
  issueId: string,
  patch: Partial<LinearIssue>,
  canPatchCacheKey: (key: string) => boolean
): {
  cache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  changed: boolean
} {
  let changed = false
  const nextCache = { ...cache }
  for (const [key, entry] of Object.entries(nextCache)) {
    if (!canPatchCacheKey(key) || !entry?.data) {
      continue
    }
    const idx = entry.data.items.findIndex((item) => item.id === issueId)
    if (idx === -1) {
      continue
    }
    const updatedItems = [...entry.data.items]
    updatedItems[idx] = { ...updatedItems[idx], ...patch }
    nextCache[key] = {
      ...entry,
      data: { ...entry.data, items: updatedItems }
    }
    changed = true
  }
  return { cache: nextCache, changed }
}
