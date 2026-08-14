import type React from 'react'
import type { AppState } from '@/store/types'
import type {
  FolderWorkspace,
  ProjectGroup,
  ProjectOrderBy,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage,
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { PendingSidebarRowReveal, PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import type { ImportedWorktreeCardActionState } from './imported-worktrees-card-actions'
import type { NewExternalWorktreesInboxActionState } from './new-external-worktrees-inbox-actions'
import type { HostSectionRow } from './host-section-rows'
import type {
  PinnedWorktreeDisplayPolicy,
  ProjectGroupingModel,
  WorktreeGroupBy
} from './worktree-list-groups'
import type { WorktreeDragGroup } from './worktree-manual-order'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'

export type VirtualizedWorktreeViewportProps = {
  rows: HostSectionRow[]
  activeWorktreeId: string | null
  currentWorktreeId: string | null
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  projectOrderBy: ProjectOrderBy
  toggleGroup: (key: string) => void
  collapsedGroups: Set<string>
  handleCreateForRepo: (projectId: string) => void
  handleOpenRepoSettings: (projectId: string, sectionId?: string) => void
  handleOpenWorktreeVisibility: (repo: Repo) => void
  handleShowImportedWorktrees: (projectId: string) => void
  handleKeepImportedWorktreesHidden: (projectId: string) => void
  importedWorktreeCardActionState: ReadonlyMap<string, ImportedWorktreeCardActionState>
  handleOpenSuppressExternalWorktreeInbox: (projectId: string) => void
  newExternalWorktreeInboxActionState: ReadonlyMap<string, NewExternalWorktreesInboxActionState>
  handleRemoveProject: (repo: Repo) => void
  handleCreateGroupFromRepo: (repo: Repo) => void
  handleMoveProjectToGroup: (repo: Repo, groupId: string) => void
  handleRemoveProjectFromGroup: (repo: Repo) => void
  handleRenameProjectGroup: (groupId: string, currentName: string) => void
  handleDeleteProjectGroup: (groupId: string, groupName: string) => void
  handleCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
  activeModal: string
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  pendingRevealSidebarRow: PendingSidebarRowReveal | null
  clearPendingRevealWorktreeId: () => void
  clearPendingRevealSidebarRow: () => void
  agentSendTargetWorktreeId: string | null
  worktrees: Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onImmediateWorktreeActivate: (worktreeId: string, rowKey: string | undefined) => void
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  repoMap: Map<string, Repo>
  defaultHostId: ExecutionHostId
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  // Full canonical repo-id order; must include hidden repos or a reorder silently drops them.
  allRepoIds: string[]
  onReorderHostSections: (orderedHostIds: ExecutionHostId[]) => void
  onHostDragActiveChange: (active: boolean) => void
  prCache: AppState['prCache'] | null
  hostedReviewCache: AppState['hostedReviewCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGrouping?: ProjectGroupingModel
  projectGroups?: readonly ProjectGroup[]
  onMoveWorktreeToStatus: (worktreeId: string, status: WorkspaceStatus) => void
  onMoveWorktreesToStatus: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onMoveWorktreesToStatusAtIndex: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
    groups: readonly WorktreeDragGroup[]
  }) => void
  onPinWorktree: (worktreeId: string) => void
  onPinWorktrees: (worktreeIds: readonly string[]) => void
  onDropWorktreesOnWorkspaceBoard: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
    groups: readonly WorktreeDragGroup[]
  }) => void
  workspaceBoardOpen: boolean
  onWorkspaceBoardDragPreviewStart: () => void
  onWorkspaceBoardDragPreviewCommit: () => void
  onWorkspaceBoardDragPreviewCancel: () => void
  shouldShowWorkspaceBoardDropIndicator: (
    worktreeIds: readonly string[],
    status: WorkspaceStatus
  ) => boolean
  onReorderWorktrees: (args: {
    groups: readonly WorktreeDragGroup[]
    sourceGroupKey: string
    draggedIds: readonly string[]
    dropIndex: number
  }) => void
  // Why: grouping remounts the viewport, add/delete stays mounted; bridge both so the virtualizer never resets to scrollTop 0.
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
}
