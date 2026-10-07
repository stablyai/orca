import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getFolderWorkspaceAttachmentIdentity } from './folder-workspace-attached'
import { getFolderWorkspaceAttachedGroupKey } from './group-keys'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import { appendWorktreeRows } from './row-builders'
import type { FolderWorkspaceRow, Row } from './row-types'

/** The one folder-workspace row constructor, shared by the project-group,
 *  grouped-lane and flat emitters so their rows cannot diverge. */
export function buildFolderWorkspaceRow(
  pair: RenderableFolderWorkspace,
  groupDepth: number,
  attached: { childCount: number; collapsed: boolean } = { childCount: 0, collapsed: false },
  defaultHostId?: ExecutionHostId
): FolderWorkspaceRow {
  const identity = getFolderWorkspaceAttachmentIdentity(pair, defaultHostId)
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${identity}`,
    folderWorkspace: pair.folderWorkspace,
    projectGroup: pair.projectGroup,
    depth: 0,
    groupDepth,
    attachedChildCount: attached.childCount,
    ...(attached.childCount > 0
      ? {
          attachedGroupKey: getFolderWorkspaceAttachedGroupKey(identity),
          attachedCollapsed: attached.collapsed
        }
      : {})
  }
}

/**
 * Emits each folder workspace row followed by its attached worktrees, nested one
 * level deep (cross-status nesting: a child renders under its folder whatever
 * lane the child's own status would have put it in).
 */
export function appendFolderWorkspaceRows(
  result: Row[],
  pairs: readonly RenderableFolderWorkspace[],
  groupDepth: number,
  options: {
    defaultHostId: ExecutionHostId
    attachedByFolderId: ReadonlyMap<string, Worktree[]>
    repoMap: Map<string, Repo>
    lineageById: Record<string, WorktreeLineage>
    worktreeMap: Map<string, Worktree>
    nestLineage: boolean
    collapsedGroups: Set<string>
    cyclicLineageIds: ReadonlySet<string>
    hostContextLabelByWorktreeIdentity?: ReadonlyMap<string, string>
  }
): void {
  for (const pair of pairs) {
    const identity = getFolderWorkspaceAttachmentIdentity(pair, options.defaultHostId)
    const attached = options.attachedByFolderId.get(identity) ?? []
    const collapsed = options.collapsedGroups.has(getFolderWorkspaceAttachedGroupKey(identity))
    result.push(
      buildFolderWorkspaceRow(
        pair,
        groupDepth,
        { childCount: attached.length, collapsed },
        options.defaultHostId
      )
    )
    if (attached.length === 0 || collapsed) {
      continue
    }
    appendWorktreeRows(
      result,
      attached,
      options.repoMap,
      options.lineageById,
      options.worktreeMap,
      {
        nestLineage: options.nestLineage,
        collapsedGroups: options.collapsedGroups,
        groupDepth,
        sectionKey: `folder:${identity}`,
        hostContextLabelByWorktreeIdentity: options.hostContextLabelByWorktreeIdentity,
        cyclicLineageIds: options.cyclicLineageIds,
        baseDepth: 1
      }
    )
  }
}
