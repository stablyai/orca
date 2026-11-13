import type { FolderWorkspace } from '../../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../project-group-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../execution-host'
import { getFolderWorkspaceHostId } from '../../folder-workspaces/folder-workspace-host-id'
import type { WorkspaceStatusDefinition } from '../../worktree/types'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../../workspace-statuses'
import { ALL_GROUP_KEY } from '../sections/group-keys'
import { getPRLaneKey } from '../../workspace-view/workspace-pr-groups'
import { compareCodePoints, compareSidebarText } from '../sorting/text-order'
import type { WorktreeGroupBy } from '../row-types'

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
    // Stamp an unstamped folder the way catalog adoption does, so its card, label and section name
    // the host it runs on (folder-workspace-execution-host.ts).
    const hostId = folderWorkspace.executionHostId
      ? null
      : getFolderWorkspaceHostId(folderWorkspace, projectGroups)
    renderable.push({
      folderWorkspace:
        hostId && hostId !== LOCAL_EXECUTION_HOST_ID
          ? { ...folderWorkspace, executionHostId: hostId }
          : folderWorkspace,
      projectGroup
    })
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

type FolderWorkspaceDisplayOrder = Pick<
  FolderWorkspace,
  'id' | 'name' | 'sortOrder' | 'manualOrder' | 'executionHostId'
>

/** Match project-group ordering: user rank, then name. */
export function compareFolderWorkspacesForDisplay(
  left: FolderWorkspaceDisplayOrder,
  right: FolderWorkspaceDisplayOrder
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
