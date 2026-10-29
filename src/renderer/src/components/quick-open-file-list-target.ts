import { useState } from 'react'
import type { Worktree } from '../../../shared/worktree/types'
import { getNestedWorktreeExcludePaths } from './quick-open-nested-worktrees'

export type NestedWorktreeExcludeRequest = {
  paths: string[]
  key: string
}

export type RuntimeFileListTarget = {
  canList: boolean
  excludeRequest: NestedWorktreeExcludeRequest
  worktreePath: string | null
}

export function getRuntimeFileListTarget(
  worktreeId: string | null,
  worktreePath: string | null | undefined,
  repoWorktrees: readonly Worktree[]
): RuntimeFileListTarget {
  const resolvedWorktreePath = worktreePath ?? null
  if (!worktreeId || !resolvedWorktreePath) {
    return { canList: false, excludeRequest: { paths: [], key: '[]' }, worktreePath: null }
  }
  return {
    canList: true,
    excludeRequest: getNestedWorktreeExcludeRequest(
      worktreeId,
      resolvedWorktreePath,
      repoWorktrees
    ),
    worktreePath: resolvedWorktreePath
  }
}

export function getNestedWorktreeExcludeRequest(
  worktreeId: string | null,
  worktreePath: string | null,
  repoWorktrees: readonly Worktree[]
): NestedWorktreeExcludeRequest {
  if (!worktreeId || !worktreePath || repoWorktrees.length === 0) {
    return { paths: [], key: '[]' }
  }
  const paths = getNestedWorktreeExcludePaths(worktreeId, worktreePath, repoWorktrees)
  // JSON preserves newline-containing paths in stable dependency keys; pass the original path array to IPC.
  return { paths, key: JSON.stringify(paths) }
}

// Why: worktree metadata updates rebuild the request object; only a key change should restart scans.
export function useKeyedExcludeRequest(
  request: NestedWorktreeExcludeRequest
): NestedWorktreeExcludeRequest {
  const [keyed, setKeyed] = useState(request)
  if (keyed.key !== request.key) {
    setKeyed(request)
  }
  return keyed.key === request.key ? keyed : request
}
