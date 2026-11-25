import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getHiddenMainCheckouts } from '../../../../../../shared/sidebar-list/selection/hidden-main-checkouts'

/** Main checkouts the row filters dropped; they hold their project's chats, so their activity still ranks it. */
export function useHiddenMainCheckouts(
  /** The registrations the list shows, already narrowed to the visible hosts. */
  repos: readonly Repo[],
  visibleWorktrees: readonly Worktree[],
  defaultHostId: ExecutionHostId
): readonly Worktree[] {
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  return useMemo(
    () => getHiddenMainCheckouts({ repos, worktreesByRepo, visibleWorktrees }, defaultHostId),
    [repos, visibleWorktrees, worktreesByRepo, defaultHostId]
  )
}
