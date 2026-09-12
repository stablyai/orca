import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

export type LocalPreflightContext =
  | {
      wslDistro?: string | null
      wslDefault?: boolean
      runtimeContextKey?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
      /** Mirrors `PreflightRuntimeContext.sshHost`: names the SSH execution host
       *  whose forge CLIs preflight should additionally probe. */
      sshHost?: { connectionId: string; hostLabel: string }
    }
  | undefined

// Why: selector snapshots must be reference-stable, but project/runtime ids can
// churn as repos are added and removed during a long-lived renderer session.
const WSL_PREFLIGHT_CONTEXT_CACHE_MAX = 128
const PROJECT_RUNTIME_PREFLIGHT_CONTEXT_CACHE_MAX = 2048
const SSH_HOST_PREFLIGHT_CONTEXT_CACHE_MAX = 128

// Why: these reads run inside broad store selectors. Insertion-order eviction
// keeps cache hits read-only instead of adding Map mutations to every store update.
const wslPreflightContextsByDistro = new Map<string, NonNullable<LocalPreflightContext>>()
const projectRuntimePreflightContextsByKey = new Map<string, NonNullable<LocalPreflightContext>>()
const sshHostPreflightContextsByKey = new Map<string, NonNullable<LocalPreflightContext>>()

export function resetLocalPreflightContextCachesForTests(): void {
  wslPreflightContextsByDistro.clear()
  projectRuntimePreflightContextsByKey.clear()
  sshHostPreflightContextsByKey.clear()
}

export function _getWslPreflightContextCacheSizeForTest(): number {
  return wslPreflightContextsByDistro.size
}

export function _hasWslPreflightContextCacheEntryForTest(wslDistro: string): boolean {
  return wslPreflightContextsByDistro.has(wslDistro)
}

export function _getProjectRuntimePreflightContextCacheSizeForTest(): number {
  return projectRuntimePreflightContextsByKey.size
}

export function _hasProjectRuntimePreflightContextCacheEntryForTest(cacheKey: string): boolean {
  return projectRuntimePreflightContextsByKey.has(cacheKey)
}

export function getWslPreflightContext(wslDistro: string): NonNullable<LocalPreflightContext> {
  const cached = wslPreflightContextsByDistro.get(wslDistro)
  if (cached) {
    return cached
  }

  // Why: React/Zustand selectors must return a cached snapshot. A fresh object
  // here triggers a useSyncExternalStore loop when Settings observes WSL repos.
  const context = Object.freeze({ wslDistro })
  storeCacheEntry(wslPreflightContextsByDistro, wslDistro, context, WSL_PREFLIGHT_CONTEXT_CACHE_MAX)
  return context
}

export function getSshHostPreflightContext(
  connectionId: string,
  hostLabel: string
): NonNullable<LocalPreflightContext> {
  // Why: the label is part of the key — a renamed target must produce a fresh
  // snapshot so the card stops showing the old host name.
  const cacheKey = JSON.stringify([connectionId, hostLabel])
  const cached = sshHostPreflightContextsByKey.get(cacheKey)
  if (cached) {
    return cached
  }

  const context = Object.freeze({ sshHost: Object.freeze({ connectionId, hostLabel }) })
  storeCacheEntry(
    sshHostPreflightContextsByKey,
    cacheKey,
    context,
    SSH_HOST_PREFLIGHT_CONTEXT_CACHE_MAX
  )
  return context
}

export function getProjectRuntimePreflightContext(
  resolution: ProjectExecutionRuntimeResolution
): NonNullable<LocalPreflightContext> {
  const cacheKey = getProjectRuntimeContextObjectCacheKey(resolution)
  const cached = projectRuntimePreflightContextsByKey.get(cacheKey)
  if (cached) {
    return cached
  }

  const wslDistro =
    resolution.status === 'resolved' && resolution.runtime.kind === 'wsl'
      ? resolution.runtime.distro
      : undefined
  // Why: selectors compare by reference; cache each resolved runtime context so
  // adding projectRuntime does not reintroduce useSyncExternalStore churn.
  const context = Object.freeze({
    ...(wslDistro ? { wslDistro } : {}),
    projectRuntime: resolution
  })
  storeCacheEntry(
    projectRuntimePreflightContextsByKey,
    cacheKey,
    context,
    PROJECT_RUNTIME_PREFLIGHT_CONTEXT_CACHE_MAX
  )
  return context
}

function getProjectRuntimeContextObjectCacheKey(
  resolution: ProjectExecutionRuntimeResolution
): string {
  if (resolution.status === 'resolved') {
    return `${resolution.runtime.cacheKey}:${resolution.runtime.reason}`
  }
  return `${resolution.repair.cacheKey}:${resolution.repair.source}`
}

function storeCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  maxEntries: number
): void {
  cache.set(key, value)
  if (cache.size > maxEntries) {
    const oldest = cache.keys().next()
    if (!oldest.done) {
      cache.delete(oldest.value)
    }
  }
}
