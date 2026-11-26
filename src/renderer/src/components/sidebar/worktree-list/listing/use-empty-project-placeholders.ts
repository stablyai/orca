import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { indexHiddenProjects } from '../../../../../../shared/project/catalog/hidden-projects'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getEmptyProjectPlaceholderRepoIds } from '../../../../../../shared/sidebar-list/catalog/empty-project-placeholder-repos'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { isDefaultBranchWorkspace } from '../../../../../../shared/worktree/visibility/workspace-kinds'
import { isProjectTreeOn } from '../../../../../../shared/sidebar-list/project-tree-settings'
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
  const hideDefaultBranch = useAppStore(
    (s) => s.hideDefaultBranchWorkspace && isProjectTreeOn(s.settings)
  )
  const hiddenVmCheckouts = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  return useMemo(
    () =>
      getEmptyProjectPlaceholderRepoIds({
        groupBy,
        repos: visibleRepos,
        // A hidden main checkout still holds the project's chats, so its header always stays.
        worktreesByRepo: hideDefaultBranch
          ? asEmptyWhereMainCheckoutHidden(worktreesByRepo, visibleRepos)
          : worktreesByRepo,
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
      hideDefaultBranch,
      visibleWorktrees,
      filterRepoIds,
      defaultHostId,
      hiddenVmCheckouts
    ]
  )
}

// Why empty, not just minus main: a project's other worktrees can sit under another project's
// lineage parent, which would leave it with no section; a placeholder is a no-op where one exists.
function asEmptyWhereMainCheckoutHidden(
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>,
  repos: readonly Repo[]
): Record<string, readonly Worktree[] | undefined> {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  return Object.fromEntries(
    Object.entries(worktreesByRepo).map(([repoId, worktrees]) => [
      repoId,
      worktrees?.some((worktree) => isDefaultBranchWorkspace(worktree, repoById.get(repoId)))
        ? []
        : worktrees
    ])
  )
}
