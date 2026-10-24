import type { FolderWorkspace } from '../folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import type { WorkspaceStatusDefinition } from '../worktree/types'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../workspace-statuses'
import { ALL_GROUP_KEY, getPRLaneKey } from './group-keys'
import { compareCodePoints, compareSidebarText } from './text-order'
import type { WorktreeGroupBy } from './row-types'

/** Carry the owning ProjectGroup through emission: FolderWorkspaceRow requires it and emitters cannot resolve owners. */
export type RenderableFolderWorkspace = {
  folderWorkspace: FolderWorkspace
  projectGroup: ProjectGroup
}

/** Resolve membership before grouping so every mode renders the same folder workspaces (#15362); modes choose lanes only. */
export function getRenderableFolderWorkspaces(
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): RenderableFolderWorkspace[] {
  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const renderable: RenderableFolderWorkspace[] = []
  for (const folderWorkspace of folderWorkspaces) {
    const projectGroup = projectGroupsById.get(folderWorkspace.projectGroupId)
    // A group filtered out for host visibility legitimately hides its workspaces.
    if (!projectGroup?.parentPath) {
      continue
    }
    renderable.push({ folderWorkspace, projectGroup })
  }
  return renderable
}

/** Switch exhaustively so new grouping modes cannot silently hide folder workspaces again. */
export function getFolderWorkspaceLaneKey(
  pair: RenderableFolderWorkspace,
  groupBy: Exclude<WorktreeGroupBy, 'repo'>,
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
): string {
  switch (groupBy) {
    case 'workspace-status':
      return getWorkspaceStatusGroupKey(getWorkspaceStatus(pair.folderWorkspace, workspaceStatuses))
    case 'pr-status':
      // Folders cannot resolve a PR; match worktrees without one in the in-progress lane.
      return getPRLaneKey('in-progress')
    case 'none':
      return ALL_GROUP_KEY
  }
}

/** Match project-group ordering: user rank, then name. */
export function compareFolderWorkspacesForDisplay(
  left: FolderWorkspace,
  right: FolderWorkspace
): number {
  const leftOrder = left.manualOrder ?? left.sortOrder
  const rightOrder = right.manualOrder ?? right.sortOrder
  return (
    rightOrder - leftOrder ||
    compareSidebarText(left.name, right.name) ||
    compareCodePoints(left.executionHostId ?? '', right.executionHostId ?? '') ||
    compareCodePoints(left.id, right.id)
  )
}
