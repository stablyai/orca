import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { SidebarFilterQueryEvaluation } from '../../sidebar-filter-query-evaluation'
import { workspaceMatchesFilterQuery } from '../../workspace-filter-query-match'
import { buildFolderWorkspaceFilterSubject } from '../../workspace-filter-subject'
import type { useSidebarHostVisibleScope } from './use-host-visible-scope'

type SidebarHostVisibleScope = ReturnType<typeof useSidebarHostVisibleScope>

/**
 * Narrows the host-visible row scope by the typed query and publishes the
 * match count the filter field shows. Projects stay only while a workspace of
 * theirs survives, and folder workspaces answer the same grammar.
 */
export function useSidebarFilterQueryScope(args: {
  hostVisibleScope: SidebarHostVisibleScope
  filterQuery: SidebarFilterQueryEvaluation | null
  visibleWorktrees: readonly Worktree[]
  projectGroups: readonly ProjectGroup[]
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string>
}): SidebarHostVisibleScope {
  const { hostVisibleScope, filterQuery, visibleWorktrees, projectGroups } = args
  const { defaultHostId, hostLabelById } = args

  // Why optional: lightweight test stores mock only the slices they exercise.
  const setSidebarFilterMatchCount = useAppStore((s) => s.setSidebarFilterMatchCount)
  useEffect(() => {
    setSidebarFilterMatchCount?.(filterQuery ? visibleWorktrees.length : null)
  }, [filterQuery, setSidebarFilterMatchCount, visibleWorktrees.length])
  useEffect(() => () => setSidebarFilterMatchCount?.(null), [setSidebarFilterMatchCount])

  return useMemo(() => {
    if (!filterQuery) {
      return hostVisibleScope
    }
    const repoIdsWithVisibleWorktrees = new Set(visibleWorktrees.map((w) => w.repoId))
    const subjectContext = {
      defaultHostId,
      hostLabelById,
      statusLabelById: filterQuery.statusLabelById
    }
    const visibleFolderWorkspacesForRows = hostVisibleScope.visibleFolderWorkspacesForRows.filter(
      (folderWorkspace) =>
        workspaceMatchesFilterQuery({
          parsed: filterQuery.parsed,
          subject: buildFolderWorkspaceFilterSubject(
            folderWorkspace,
            projectGroups.find((group) => group.id === folderWorkspace.projectGroupId),
            subjectContext
          ),
          rowKey: folderWorkspace.id,
          // Why: folder workspaces have no palette index, so free text falls
          // back to the substring rules inside the matcher.
          verdicts: { identityMatched: null, anyMatched: null }
        })
    )
    const projectGroupIdsWithVisibleFolders = new Set(
      visibleFolderWorkspacesForRows.map((folderWorkspace) => folderWorkspace.projectGroupId)
    )
    const visibleReposForRows = hostVisibleScope.visibleReposForRows.filter((repo) =>
      repoIdsWithVisibleWorktrees.has(repo.id)
    )
    const visibleRepoGroupIds = new Set(
      visibleReposForRows.map((repo) => repo.projectGroupId).filter((id) => id != null)
    )
    return {
      visibleReposForRows,
      visibleProjectGroupsForRows: hostVisibleScope.visibleProjectGroupsForRows.filter(
        (group) =>
          visibleRepoGroupIds.has(group.id) || projectGroupIdsWithVisibleFolders.has(group.id)
      ),
      visibleFolderWorkspacesForRows
    }
  }, [defaultHostId, filterQuery, hostLabelById, hostVisibleScope, projectGroups, visibleWorktrees])
}
