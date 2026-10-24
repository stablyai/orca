import type { WorktreeOccurrencePlan } from '../../../../../../shared/worktree-occurrence-plan'
import type React from 'react'
import type { AppState } from '@/store/types'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { PendingSidebarRowReveal, PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host-registry'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { ImportedWorktreeCardActionState } from '../../imported-worktrees-card-actions'
import type { NewExternalWorktreesInboxActionState } from '../../new-external-worktrees-inbox-actions'
import type {
  ShouldShowWorkspaceBoardDropIndicator,
  WorktreeDropCommitContext,
  WorktreeReorderArgs,
  WorktreeStatusDropAtIndexArgs
} from '../drag/drop-commit-context'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'

export const EMPTY_PROJECT_GROUPS: readonly ProjectGroup[] = []
export type VirtualizedWorktreeViewportProps = {
  occurrencePlan?: WorktreeOccurrencePlan<Worktree>
  visibleProjectRepoIdsBySection?: ReadonlyMap<string, ReadonlySet<string>>
  rows: HostSectionRow[]
  hostOptions?: readonly ExecutionHostRegistryEntry[]
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
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
  handleRenameProjectGroup: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  handleDeleteProjectGroup: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
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
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
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
  /** The host-filtered groups the rows were built from; reveal must walk the same parents. */
  visibleProjectGroups?: readonly ProjectGroup[]
  onMoveWorktreeToStatus: (worktreeId: string, status: WorkspaceStatus) => void
  onMoveWorktreesToStatus: WorktreeDropCommitContext['onMoveWorktreesToStatus']
  onMoveWorktreesToStatusAtIndex: (args: WorktreeStatusDropAtIndexArgs) => void
  onPinWorktree: (worktreeId: string) => void
  onPinWorktrees: WorktreeDropCommitContext['onPinWorktrees']
  onDropWorktreesOnWorkspaceBoard: (args: WorktreeStatusDropAtIndexArgs) => void
  workspaceBoardOpen: boolean
  onWorktreeCardClick?: () => void
  onWorkspaceBoardDragPreviewStart: () => void
  onWorkspaceBoardDragPreviewCommit: () => void
  onWorkspaceBoardDragPreviewCancel: () => void
  shouldShowWorkspaceBoardDropIndicator: ShouldShowWorkspaceBoardDropIndicator
  onReorderWorktrees: (args: WorktreeReorderArgs) => void
  // Why: grouping remounts the viewport, add/delete stays mounted; bridge both so the virtualizer never resets to scrollTop 0.
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
}
