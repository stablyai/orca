import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

export type LocalPreflightContext =
  | {
      wslDistro?: string | null
      wslDefault?: boolean
      runtimeContextKey?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
    }
  | undefined

// Bound reference-stable selector snapshots as project/runtime IDs churn over a long renderer session.
const WSL_PREFLIGHT_CONTEXT_CACHE_MAX = 128
const PROJECT_RUNTIME_PREFLIGHT_CONTEXT_CACHE_MAX = 2048

// Insertion-order eviction keeps broad-selector cache hits read-only rather than mutating Map on every store write.
const wslPreflightContextsByDistro = new Map<string, NonNullable<LocalPreflightContext>>()
const projectRuntimePreflightContextsByKey = new Map<string, NonNullable<LocalPreflightContext>>()

export function resetLocalPreflightContextCachesForTests(): void {
  wslPreflightContextsByDistro.clear()
  projectRuntimePreflightContextsByKey.clear()
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

  // Cache snapshot identities or Settings’ WSL selectors can loop through useSyncExternalStore.
  const context = Object.freeze({ wslDistro })
  storeCacheEntry(wslPreflightContextsByDistro, wslDistro, context, WSL_PREFLIGHT_CONTEXT_CACHE_MAX)
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
  // Cache runtime contexts too so adding projectRuntime cannot reintroduce selector identity churn.
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
