import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import {
  getWorkspaceStatus,
  getWorkspaceStatusGroupKey
} from '../../../../../../shared/workspace-statuses'
import { ALL_GROUP_KEY, getPRLaneKey } from './group-keys'
import type { WorktreeGroupBy } from './row-types'

/** A folder workspace paired with the project group that owns it. The pair is
 *  carried through grouping because FolderWorkspaceRow needs a non-optional
 *  ProjectGroup and the section emitters have no owner resolver. */
export type RenderableFolderWorkspace = {
  folderWorkspace: FolderWorkspace
  projectGroup: ProjectGroup
}

/**
 * The single place that decides which folder workspaces can render.
 *
 * Why one place: membership used to be computed inside the repo-grouping branch,
 * so every other Group by mode dropped folder workspaces entirely (#15362).
 * Modes may choose a lane; they may never subtract from this list.
 */
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

/**
 * Which lane a folder workspace belongs to, per Group by mode.
 *
 * Deliberately exhaustive with no `default:` so a new WorktreeGroupBy variant is
 * a compile error here rather than a silent fall-through that hides folder
 * workspaces again. Total by construction: a folder workspace always gets a lane.
 */
export function getFolderWorkspaceLaneKey(
  pair: RenderableFolderWorkspace,
  groupBy: Exclude<WorktreeGroupBy, 'repo'>,
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
): string {
  switch (groupBy) {
    case 'workspace-status':
      return getWorkspaceStatusGroupKey(getWorkspaceStatus(pair.folderWorkspace, workspaceStatuses))
    case 'pr-status':
      // Why in-progress: a folder workspace has no branch or repo, so it can
      // never resolve a PR. getPRGroupKey returns this same lane for any
      // worktree without one, so the two stay consistent.
      return getPRLaneKey('in-progress')
    case 'none':
      return ALL_GROUP_KEY
  }
}

/** Sidebar display order: user-authored order first, then name. Mirrors the rule
 *  the project-group emitter has always used, so lanes and groups agree. */
export function compareFolderWorkspacesForDisplay(
  left: FolderWorkspace,
  right: FolderWorkspace
): number {
  const leftOrder = left.manualOrder ?? left.sortOrder
  const rightOrder = right.manualOrder ?? right.sortOrder
  return rightOrder - leftOrder || left.name.localeCompare(right.name)
}
