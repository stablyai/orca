import type { AppState } from '@/store/types'
import { parseWslUncPath } from '../../../shared/wsl-paths'

export type LocalPreflightContext = { wslDistro?: string | null } | undefined

const wslPreflightContextsByDistro = new Map<string, NonNullable<LocalPreflightContext>>()

export function getWslDistroFromPath(path?: string | null): string | null {
  return path ? (parseWslUncPath(path)?.distro ?? null) : null
}

function getWslPreflightContext(wslDistro: string): NonNullable<LocalPreflightContext> {
  const cached = wslPreflightContextsByDistro.get(wslDistro)
  if (cached) {
    return cached
  }

  // Why: React/Zustand selectors must return a cached snapshot. A fresh object
  // here triggers a useSyncExternalStore loop when Settings observes WSL repos.
  const context = Object.freeze({ wslDistro })
  wslPreflightContextsByDistro.set(wslDistro, context)
  return context
}

export function getLocalPreflightContext(state: AppState): LocalPreflightContext {
  const activeWorktree = state.activeWorktreeId
    ? Object.values(state.worktreesByRepo ?? {})
        .flat()
        .find((worktree) => worktree.id === state.activeWorktreeId)
    : null
  const activePath =
    activeWorktree?.path ?? (state.repos ?? []).find((repo) => repo.id === state.activeRepoId)?.path
  const wslDistro = getWslDistroFromPath(activePath)
  return wslDistro ? getWslPreflightContext(wslDistro) : undefined
}

export function localPreflightContextKey(context: LocalPreflightContext): string {
  return context?.wslDistro ? `wsl:${context.wslDistro}` : 'host'
}
