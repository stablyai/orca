import type { AppState } from '@/store/types'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../../../shared/folder-workspace-path-status'
import { isConfirmedStaleFolderPathStatus } from '../../../../shared/folder-workspace-path-status'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import { getRepoHeaderCreateState, type RepoHeaderCreateState } from './repo-header-create-state'
import { resolveProjectGroupHeaderColor } from './project-header-color'
import type { GroupHeaderRow, WorktreeGroupBy } from './worktree-list-groups'
import { PINNED_GROUP_KEY } from './worktree-list-groups'
import {
  WORKTREE_SECTION_HEADER_PADDING_LEFT,
  getProjectGroupHeaderPaddingLeft
} from './worktree-list-indentation'
import type { RenderRow } from './worktree-list-virtual-rows'
import { shouldUseHeaderTopSpacing } from './worktree-list-virtual-rows'
import { getWorkspaceStatusFromGroupKey } from './workspace-status'

export type WorktreeListSectionHeaderModel = {
  isActiveStickyHeader: boolean
  stickyTopClass: string
  hasHeaderTopSpacing: boolean
  projectIdForHeader: string | undefined
  projectGroupIdForHeader: string | undefined
  repoHeaderIndex: number | undefined
  repoHeaderBucketKey: string | undefined
  repoHeaderSectionEnd: number | undefined
  projectGroupHeaderIndex: number | undefined
  projectGroupHeaderBucketKey: string | undefined
  projectGroupHeaderSectionEnd: number | undefined
  isDraggableRepoHeader: boolean
  isDraggableProjectGroupHeader: boolean
  isDraggingThis: boolean
  isDraggingThisProjectGroup: boolean
  headerWorkspaceStatus: WorkspaceStatus | null
  isPinnedHeader: boolean
  repoHeaderColor: string | undefined
  createState: RepoHeaderCreateState | null
  projectGroupPathStatus: FolderWorkspacePathStatus | null
  folderWorkspaceCreateDisabled: boolean
  isHeaderCollapsed: boolean
  showHeaderCollapseAffordance: boolean
  headerPaddingLeft: number
}

export function getWorktreeListSectionHeaderModel(args: {
  row: GroupHeaderRow
  index: number
  renderRows: readonly RenderRow[]
  firstHeaderIndex: number
  activeStickyHeaderIndex: number | null
  activeStickyHostIndex: number | null
  groupBy: WorktreeGroupBy
  canReorderRepoHeaders: boolean
  canReorderProjectGroupHeaders: boolean
  repoHeaderIndexByRepoId: ReadonlyMap<string, number>
  repoHeaderBucketByRepoId: ReadonlyMap<string, string>
  repoHeaderSectionEndByRepoId: ReadonlyMap<string, number>
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  projectGroupHeaderIndexByGroupId: ReadonlyMap<string, number>
  projectGroupHeaderBucketByGroupId: ReadonlyMap<string, string>
  projectGroupHeaderSectionEndByGroupId: ReadonlyMap<string, number>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  draggingRepoId: string | null
  draggingProjectGroupId: string | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  sshConnectionStates: AppState['sshConnectionStates']
  getCachedFolderWorkspacePathStatus: (
    request: FolderWorkspacePathStatusRequest
  ) => FolderWorkspacePathStatus | null
  collapsedGroups: ReadonlySet<string>
}): WorktreeListSectionHeaderModel {
  const { row } = args
  const isRepoHeader = args.groupBy === 'repo' && row.repo !== undefined
  const isProjectGroupHeader = args.groupBy === 'repo' && row.projectGroup !== undefined
  const projectIdForHeader = isRepoHeader ? row.repo?.id : undefined
  const projectGroupIdForHeader =
    isProjectGroupHeader && !row.repo && typeof row.projectGroup?.id === 'string'
      ? row.projectGroup.id
      : undefined
  const repoHeaderBucketKey =
    projectIdForHeader !== undefined
      ? args.repoHeaderBucketByRepoId.get(projectIdForHeader)
      : undefined
  const projectGroupHeaderBucketKey =
    projectGroupIdForHeader !== undefined
      ? args.projectGroupHeaderBucketByGroupId.get(projectGroupIdForHeader)
      : undefined
  const isDraggableRepoHeader = Boolean(
    args.canReorderRepoHeaders &&
    isRepoHeader &&
    projectIdForHeader &&
    repoHeaderBucketKey &&
    (args.sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1
  )
  const isDraggableProjectGroupHeader = Boolean(
    args.canReorderProjectGroupHeaders &&
    projectGroupIdForHeader &&
    projectGroupHeaderBucketKey &&
    (args.sidebarProjectGroupHeaderIdsByBucket.get(projectGroupHeaderBucketKey)?.length ?? 0) > 1
  )
  const headerWorkspaceStatus =
    args.groupBy === 'workspace-status'
      ? getWorkspaceStatusFromGroupKey(row.key, args.workspaceStatuses)
      : null
  const isPinnedHeader = row.key === PINNED_GROUP_KEY
  const projectGroupPathStatus =
    isProjectGroupHeader &&
    row.projectGroup &&
    'parentPath' in row.projectGroup &&
    row.projectGroup.parentPath
      ? args.getCachedFolderWorkspacePathStatus({
          scope: 'project-group',
          projectGroupId: row.projectGroup.id
        })
      : null
  const folderWorkspaceCreateDisabled =
    projectGroupPathStatus?.exists === false &&
    (isConfirmedStaleFolderPathStatus(projectGroupPathStatus) ||
      projectGroupPathStatus.reason === 'ambiguous-connection')
  const showHeaderCollapseAffordance =
    row.count > 0 &&
    (isRepoHeader || isProjectGroupHeader || headerWorkspaceStatus !== null || isPinnedHeader)

  return {
    isActiveStickyHeader: args.activeStickyHeaderIndex === args.index,
    // Why: when a host card is pinned, the group tier pins flush beneath it, not at the viewport top.
    stickyTopClass: args.activeStickyHostIndex !== null ? 'top-[35px]' : '-top-px',
    hasHeaderTopSpacing: shouldUseHeaderTopSpacing({
      rows: args.renderRows,
      index: args.index,
      firstHeaderIndex: args.firstHeaderIndex
    }),
    projectIdForHeader,
    projectGroupIdForHeader,
    repoHeaderIndex:
      projectIdForHeader !== undefined
        ? args.repoHeaderIndexByRepoId.get(projectIdForHeader)
        : undefined,
    repoHeaderBucketKey,
    repoHeaderSectionEnd:
      projectIdForHeader !== undefined
        ? args.repoHeaderSectionEndByRepoId.get(projectIdForHeader)
        : undefined,
    projectGroupHeaderIndex:
      projectGroupIdForHeader !== undefined
        ? args.projectGroupHeaderIndexByGroupId.get(projectGroupIdForHeader)
        : undefined,
    projectGroupHeaderBucketKey,
    projectGroupHeaderSectionEnd:
      projectGroupIdForHeader !== undefined
        ? args.projectGroupHeaderSectionEndByGroupId.get(projectGroupIdForHeader)
        : undefined,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    isDraggingThis:
      args.canReorderRepoHeaders &&
      args.draggingRepoId !== null &&
      args.draggingRepoId === projectIdForHeader,
    isDraggingThisProjectGroup:
      args.canReorderProjectGroupHeaders &&
      args.draggingProjectGroupId !== null &&
      args.draggingProjectGroupId === projectGroupIdForHeader,
    headerWorkspaceStatus,
    isPinnedHeader,
    repoHeaderColor: resolveProjectGroupHeaderColor({
      groupBy: args.groupBy,
      headerKey: row.key,
      badgeColor: row.repo?.badgeColor
    }),
    createState: row.repo
      ? getRepoHeaderCreateState({
          repo: row.repo,
          label: row.label,
          sshStatus: row.repo.connectionId
            ? (args.sshConnectionStates.get(row.repo.connectionId)?.status ?? null)
            : null
        })
      : null,
    projectGroupPathStatus,
    folderWorkspaceCreateDisabled,
    isHeaderCollapsed: args.collapsedGroups.has(row.key),
    // Why: repo/project/status/pinned share compact section chrome; flat "All" stays a simple label.
    showHeaderCollapseAffordance,
    // Why: non-project headers like "All" are flat-list labels; don't reserve project hierarchy indent.
    headerPaddingLeft:
      isRepoHeader || isProjectGroupHeader
        ? getProjectGroupHeaderPaddingLeft(row.projectGroupDepth ?? 0)
        : WORKTREE_SECTION_HEADER_PADDING_LEFT
  }
}
