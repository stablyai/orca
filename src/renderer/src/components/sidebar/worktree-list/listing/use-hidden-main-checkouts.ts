import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getHiddenMainCheckouts } from '../../../../../../shared/sidebar-list/selection/hidden-main-checkouts'
import type { SectionRowsArgs } from './sidebar-list-model'

/** Main checkouts the row filters dropped; they hold their project's chats, so their activity still ranks it. */
export function useHiddenMainCheckouts({
  visibleReposForRows: repos,
  worktrees: visibleWorktrees,
  defaultHostId
}: Pick<
  SectionRowsArgs,
  'visibleReposForRows' | 'worktrees' | 'defaultHostId'
>): readonly Worktree[] {
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  return useMemo(
    () => getHiddenMainCheckouts({ repos, worktreesByRepo, visibleWorktrees }, defaultHostId),
    [repos, visibleWorktrees, worktreesByRepo, defaultHostId]
  )
}
