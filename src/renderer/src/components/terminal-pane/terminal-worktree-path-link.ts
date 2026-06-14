import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { normalizeAbsolutePath } from '@/lib/terminal-path-normalization'

export type WorktreeRootPathLink = {
  id: string
  path: string
}

type WorktreeRootPathState = Pick<AppState, 'worktreesByRepo'>
type WorktreeRootPathIndex = Map<string, WorktreeRootPathLink | null>

const EMPTY_WORKTREE_ROOT_PATH_INDEX: WorktreeRootPathIndex = new Map()
const worktreeRootPathIndexCache = new WeakMap<
  WorktreeRootPathState['worktreesByRepo'],
  WorktreeRootPathIndex
>()

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

function getWorktreeRootPathIndex(
  worktreesByRepo: WorktreeRootPathState['worktreesByRepo'] | undefined
): WorktreeRootPathIndex {
  if (!worktreesByRepo) {
    return EMPTY_WORKTREE_ROOT_PATH_INDEX
  }

  const cachedIndex = worktreeRootPathIndexCache.get(worktreesByRepo)
  if (cachedIndex) {
    return cachedIndex
  }

  const index: WorktreeRootPathIndex = new Map()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      const comparisonKey = getWorktreeRootPathComparisonKey(worktree.path)
      // Why: duplicate roots are ambiguous click targets; cache that ambiguity
      // so terminal link detection avoids rescanning every workspace path.
      index.set(
        comparisonKey,
        index.has(comparisonKey) ? null : { id: worktree.id, path: worktree.path }
      )
    }
  }

  worktreeRootPathIndexCache.set(worktreesByRepo, index)
  return index
}

export function resolveKnownWorktreeRootPathLink(
  path: string,
  state: WorktreeRootPathState = useAppStore.getState()
): WorktreeRootPathLink | null {
  const pathComparisonKey = getWorktreeRootPathComparisonKey(path)
  return getWorktreeRootPathIndex(state.worktreesByRepo).get(pathComparisonKey) ?? null
}
