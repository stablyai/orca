import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { indexHiddenProjects } from '../../../../../../shared/hidden-projects'
import type { Repo } from '../../../../../../shared/repo-types'
import { getEmptyProjectPlaceholderRepoIds } from '../../../../../../shared/sidebar-list/empty-project-placeholder-repos'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

/** Repos that get an empty project header; hidden ones never do, and a filter naming only hidden ones is ignored. */
export function useEmptyProjectPlaceholderRepoIds(args: {
  groupBy: WorktreeGroupBy
  /** Every loaded repo row: decides which filter ids still name a listed project. */
  repos: readonly Repo[]
  visibleRepos: readonly Repo[]
  visibleWorktrees: readonly Worktree[]
  filterRepoIds: readonly string[]
  defaultHostId: ExecutionHostId
}): Set<string> {
  const { groupBy, repos, visibleRepos, visibleWorktrees, filterRepoIds, defaultHostId } = args
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const hiddenVmCheckouts = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  return useMemo(
    () =>
      getEmptyProjectPlaceholderRepoIds({
        groupBy,
        repos: visibleRepos,
        worktreesByRepo,
        visibleWorktrees,
        filterRepoIds,
        hiddenProjects: indexHiddenProjects(repos, defaultHostId),
        pendingVmRepoIds: hiddenVmCheckouts.repoIds
      }),
    [
      groupBy,
      repos,
      visibleRepos,
      worktreesByRepo,
      visibleWorktrees,
      filterRepoIds,
      defaultHostId,
      hiddenVmCheckouts
    ]
  )
}
