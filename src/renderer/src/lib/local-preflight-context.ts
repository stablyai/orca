import type { AppState } from '@/store/types'
import { parseWslUncPath } from '../../../shared/wsl-paths'

export type LocalPreflightContext = { wslDistro?: string | null } | undefined

export function getWslDistroFromPath(path?: string | null): string | null {
  return path ? (parseWslUncPath(path)?.distro ?? null) : null
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
  return wslDistro ? { wslDistro } : undefined
}

export function localPreflightContextKey(context: LocalPreflightContext): string {
  return context?.wslDistro ? `wsl:${context.wslDistro}` : 'host'
}
