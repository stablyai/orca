import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { normalizeAbsolutePath } from '@/lib/terminal-path-normalization'

export type WorktreeRootPathLink = {
  id: string
  path: string
}

type WorktreeRootPathState = Pick<AppState, 'worktreesByRepo'>

function isPathSeparator(value: string): boolean {
  return value === '/' || value === '\\'
}

function isDriveRoot(value: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(value)
}

export function normalizeWorktreeRootPathForTerminalLink(path: string): string {
  const normalizedAbsolutePath = normalizeAbsolutePath(path)
  if (normalizedAbsolutePath) {
    return normalizedAbsolutePath.normalized
  }

  let end = path.length
  while (end > 1 && isPathSeparator(path[end - 1])) {
    const candidate = path.slice(0, end)
    if (candidate === '/' || isDriveRoot(candidate)) {
      break
    }
    end -= 1
  }
  return path.slice(0, end)
}

function getWorktreeRootPathComparisonKey(path: string): string {
  const normalizedAbsolutePath = normalizeAbsolutePath(path)
  if (normalizedAbsolutePath) {
    return normalizedAbsolutePath.comparisonKey
  }
  return normalizeWorktreeRootPathForTerminalLink(path)
}

export function resolveKnownWorktreeRootPathLink(
  path: string,
  state: WorktreeRootPathState = useAppStore.getState()
): WorktreeRootPathLink | null {
  const pathComparisonKey = getWorktreeRootPathComparisonKey(path)
  let match: WorktreeRootPathLink | null = null

  // Why: terminal paths must switch workspaces only on exact known roots; a
  // contained file path should keep its file-opening behavior.
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      if (getWorktreeRootPathComparisonKey(worktree.path) !== pathComparisonKey) {
        continue
      }
      if (match) {
        return null
      }
      match = { id: worktree.id, path: worktree.path }
    }
  }

  return match
}
