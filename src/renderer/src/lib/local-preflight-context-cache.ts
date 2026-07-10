import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

export type LocalPreflightContext =
  | {
      wslDistro?: string | null
      wslDefault?: boolean
      runtimeContextKey?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
    }
  | undefined

// Why: React/Zustand selectors compare by reference, so preflight contexts must
// be memoized snapshots. Returning a fresh object per read triggers a
// useSyncExternalStore update loop when Settings observes WSL repos.
const wslPreflightContextsByDistro = new Map<string, NonNullable<LocalPreflightContext>>()
const projectRuntimePreflightContextsByKey = new Map<string, NonNullable<LocalPreflightContext>>()

export function getWslPreflightContext(wslDistro: string): NonNullable<LocalPreflightContext> {
  const cached = wslPreflightContextsByDistro.get(wslDistro)
  if (cached) {
    return cached
  }
  const context = Object.freeze({ wslDistro })
  wslPreflightContextsByDistro.set(wslDistro, context)
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
  const context = Object.freeze({
    ...(wslDistro ? { wslDistro } : {}),
    projectRuntime: resolution
  })
  projectRuntimePreflightContextsByKey.set(cacheKey, context)
  return context
}
