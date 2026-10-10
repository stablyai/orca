import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { AppState } from '../types'

export function worktreeBelongsToHost(worktree: { hostId?: string }, hostId: string): boolean {
  return (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
}

export function getKnownRepoWorktreeIds(
  state: AppState,
  projectId: string,
  hostId?: string
): string[] {
  const ids = new Set<string>()
  for (const worktree of state.worktreesByRepo[projectId] ?? []) {
    if (!hostId || worktreeBelongsToHost(worktree, hostId)) {
      ids.add(worktree.id)
    }
  }
  for (const worktree of state.detectedWorktreesByRepo[projectId]?.worktrees ?? []) {
    if (!hostId || worktreeBelongsToHost(worktree, hostId)) {
      ids.add(worktree.id)
    }
  }
  return [...ids]
}
