import type { GitStatusResult, GitUpstreamStatus } from '../../../../shared/git-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { GitPushTarget } from '../../../../shared/worktree/types'

const AUTOMATIC_PUSH_TARGET_UPSTREAM_REFRESH_TTL_MS = 60_000
const MAX_AUTOMATIC_PUSH_TARGET_UPSTREAM_CACHE_ENTRIES = 1024

type PushTargetUpstreamRefreshCacheEntry = {
  scopeKey: string
  status: GitUpstreamStatus
  refreshedAt: number
}

const automaticPushTargetUpstreamRefreshCache = new Map<
  string,
  PushTargetUpstreamRefreshCacheEntry
>()

function getRuntimeEnvironmentKey(target?: RuntimeClientTarget | null): string | null {
  return target?.kind === 'environment' ? target.environmentId : null
}

function getPushTargetKey(pushTarget: GitPushTarget): readonly unknown[] {
  return [
    pushTarget.remoteName,
    pushTarget.branchName,
    pushTarget.remoteUrl ?? null,
    pushTarget.remoteCreated ?? null
  ]
}

function getStatusIdentityKey(status: GitStatusResult): readonly unknown[] {
  return [status.head ?? null, status.branch ?? null]
}

function getCacheScopeKey({
  target,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget
}: {
  target?: RuntimeClientTarget | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget: GitPushTarget
}): string {
  return JSON.stringify([
    worktreeId,
    worktreePath,
    connectionId ?? null,
    getRuntimeEnvironmentKey(target),
    getPushTargetKey(pushTarget)
  ])
}

function getCacheKey({
  target,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  status
}: {
  target?: RuntimeClientTarget | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget: GitPushTarget
  status: GitStatusResult
}): string {
  return JSON.stringify([
    getCacheScopeKey({ target, worktreeId, worktreePath, connectionId, pushTarget }),
    getStatusIdentityKey(status)
  ])
}

function trimAutomaticPushTargetUpstreamRefreshCache(): void {
  for (const key of automaticPushTargetUpstreamRefreshCache.keys()) {
    if (
      automaticPushTargetUpstreamRefreshCache.size <=
      MAX_AUTOMATIC_PUSH_TARGET_UPSTREAM_CACHE_ENTRIES
    ) {
      break
    }
    automaticPushTargetUpstreamRefreshCache.delete(key)
  }
}

export function getCachedAutomaticPushTargetUpstreamStatus(input: {
  target?: RuntimeClientTarget | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget: GitPushTarget
  status: GitStatusResult
}): GitUpstreamStatus | null {
  const key = getCacheKey(input)
  const entry = automaticPushTargetUpstreamRefreshCache.get(key)
  if (!entry) {
    return null
  }
  if (Date.now() - entry.refreshedAt >= AUTOMATIC_PUSH_TARGET_UPSTREAM_REFRESH_TTL_MS) {
    automaticPushTargetUpstreamRefreshCache.delete(key)
    return null
  }
  return entry.status
}

export function storeCachedAutomaticPushTargetUpstreamStatus(
  input: {
    target?: RuntimeClientTarget | null
    worktreeId: string
    worktreePath: string
    connectionId?: string
    pushTarget: GitPushTarget
    status: GitStatusResult
  },
  upstreamStatus: GitUpstreamStatus
): void {
  automaticPushTargetUpstreamRefreshCache.set(getCacheKey(input), {
    scopeKey: getCacheScopeKey(input),
    status: upstreamStatus,
    refreshedAt: Date.now()
  })
  trimAutomaticPushTargetUpstreamRefreshCache()
}

export function invalidateAutomaticPushTargetUpstreamStatusCache(input: {
  target?: RuntimeClientTarget | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget: GitPushTarget
}): void {
  const scopeKey = getCacheScopeKey(input)
  for (const [key, entry] of automaticPushTargetUpstreamRefreshCache) {
    if (entry.scopeKey === scopeKey) {
      automaticPushTargetUpstreamRefreshCache.delete(key)
    }
  }
}

export function clearAutomaticPushTargetUpstreamStatusCache(): void {
  automaticPushTargetUpstreamRefreshCache.clear()
}
