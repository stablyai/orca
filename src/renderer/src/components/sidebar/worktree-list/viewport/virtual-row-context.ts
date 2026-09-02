import type React from 'react'
import type { AppState } from '@/store/types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RenderRow } from '../listing/render-row'
import type { LineageToggleHandler } from '../../worktree-lineage-toggle-handler-cache'
import type { SidebarRevealHighlight } from '../navigation/use-reveal-highlight'
import type { WorktreeDragRuntime } from '../drag/use-runtime'
import type { WorktreeDragSession } from '../drag/use-session'
import type { useFolderWorkspacePathStatusRows } from '../listing/use-folder-path-statuses'
import type { usePrimaryActiveWorktreeRow } from '../navigation/use-active-row'
import type { useWorkspaceStatusRowDrag } from '../drag/use-status-row-drag'
import type { useWorktreeNativeDrag } from '../drag/use-native-drag'
import type { WorktreeSidebarHeaderDrag } from '../drag/use-header-drag'
import type { WorktreeListVirtualizer } from './use-virtualizer'
import type { VirtualizedWorktreeViewportProps } from './viewport-props'
import type { WorktreeVirtualRowContext } from '../rows/virtual-row-dispatch'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../../store/worktree-visibility-defaults-by-host'

type BuildArgs = {
  props: VirtualizedWorktreeViewportProps
  projectGroups: readonly ProjectGroup[]
  renderRows: RenderRow[]
  firstHeaderIndex: number
  virtualization: WorktreeListVirtualizer
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  settings: AppState['settings']
  worktreeVisibilityDefaultsByHost: AppState['worktreeVisibilityDefaultsByHost']
  sshConnectionStates: AppState['sshConnectionStates']
  newCardStyle: boolean
  folderBackedProjectGroupIds: ReadonlySet<string>
  session: WorktreeDragSession
  runtime: WorktreeDragRuntime
  primaryActive: ReturnType<typeof usePrimaryActiveWorktreeRow>
  reveal: SidebarRevealHighlight
  statusDrag: ReturnType<typeof useWorkspaceStatusRowDrag>
  nativeDrag: ReturnType<typeof useWorktreeNativeDrag>
  headerDrag: WorktreeSidebarHeaderDrag
  getCachedFolderWorkspacePathStatus: ReturnType<typeof useFolderWorkspacePathStatusRows>
  getLineageToggleHandler: (groupKey: string) => LineageToggleHandler
  toggleGroupWithScrollAnchor: (groupKey: string) => void
  onRowClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onRowPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    worktree: Worktree,
    rowKey: string
  ) => void
}

// Assembles the per-render context the row dispatcher reads. Plain data — everything in it
// is either a prop, a memoised hook result, or a stable callback.
export function buildWorktreeVirtualRowContext(args: BuildArgs): WorktreeVirtualRowContext {
  const { props, runtime, session, statusDrag, headerDrag, primaryActive, reveal } = args
  return {
    renderRows: args.renderRows,
    firstHeaderIndex: args.firstHeaderIndex,
    activeStickyHeaderIndexRef: args.virtualization.activeStickyHeaderIndexRef,
    activeStickyHostIndexRef: args.virtualization.activeStickyHostIndexRef,
    measureVirtualRowElement: args.measureVirtualRowElement,
    groupBy: props.groupBy,
    workspaceStatuses: props.workspaceStatuses,
    activeWorktreeId: props.activeWorktreeId,
    worktreeDragState: runtime.worktreeDragState,
    orderedHostIds: headerDrag.orderedHostIds,
    hostDrag: headerDrag.hostDrag,
    toggleGroupWithScrollAnchor: args.toggleGroupWithScrollAnchor,
    importedWorktreeCardActionState: props.importedWorktreeCardActionState,
    newExternalWorktreeInboxActionState: props.newExternalWorktreeInboxActionState,
    onShowImportedWorktrees: props.handleShowImportedWorktrees,
    onKeepImportedWorktreesHidden: props.handleKeepImportedWorktreesHidden,
    onOpenWorktreeVisibility: props.handleOpenWorktreeVisibility,
    onOpenSuppressExternalWorktreeInbox: props.handleOpenSuppressExternalWorktreeInbox,
    onWorkspaceStatusDragOver: statusDrag.handleWorkspaceStatusDragOver,
    onWorkspaceStatusDragLeave: statusDrag.handleWorkspaceStatusDragLeave,
    onWorkspaceStatusDrop: statusDrag.handleWorkspaceStatusDrop,
    header: {
      groupBy: props.groupBy,
      collapsedGroups: props.collapsedGroups,
      workspaceStatuses: props.workspaceStatuses,
      projectGroups: args.projectGroups,
      sshConnectionStates: args.sshConnectionStates,
      highlightedRevealRowKey: reveal.highlightedRevealRowKey,
      dragOverStatus: runtime.dragOverStatus,
      pinDragOver: runtime.pinDragOver,
      headerDrag,
      getCachedFolderWorkspacePathStatus: args.getCachedFolderWorkspacePathStatus,
      toggleGroupWithScrollAnchor: args.toggleGroupWithScrollAnchor,
      projectActions: {
        getWorktreeVisibilityDefaults: (repo) =>
          getRepoOwnerWorktreeVisibilityDefaults(
            repo,
            args.settings,
            args.worktreeVisibilityDefaultsByHost
          ),
        onOpenRepoSettings: props.handleOpenRepoSettings,
        onOpenWorktreeVisibility: props.handleOpenWorktreeVisibility,
        onCreateGroupFromRepo: props.handleCreateGroupFromRepo,
        onMoveProjectToGroup: props.handleMoveProjectToGroup,
        onRemoveProjectFromGroup: props.handleRemoveProjectFromGroup,
        onRemoveProject: props.handleRemoveProject,
        onCreateForRepo: props.handleCreateForRepo
      },
      onRenameProjectGroup: props.handleRenameProjectGroup,
      onDeleteProjectGroup: props.handleDeleteProjectGroup,
      onCreateFolderWorkspace: props.handleCreateFolderWorkspace,
      onWorkspaceStatusDragOver: statusDrag.handleWorkspaceStatusDragOver,
      onWorkspaceStatusDragLeave: statusDrag.handleWorkspaceStatusDragLeave,
      onWorkspacePinDragOver: statusDrag.handleWorkspacePinDragOver,
      onWorkspacePinDragLeave: statusDrag.handleWorkspacePinDragLeave,
      onWorkspaceStatusDrop: statusDrag.handleWorkspaceStatusDrop
    },
    item: {
      settings: args.settings,
      groupBy: props.groupBy,
      folderBackedProjectGroupIds: args.folderBackedProjectGroupIds,
      groupKeyByRowKey: session.groupKeyByRowKey,
      groupIndexByRowKey: session.groupIndexByRowKey,
      agentSendTargetWorktreeId: props.agentSendTargetWorktreeId,
      worktreeDragState: runtime.worktreeDragState,
      worktreePointerDragRef: runtime.worktreePointerDragRef,
      nativeLineageDropTargetId: runtime.nativeLineageDropTargetId,
      activeWorktreeId: props.activeWorktreeId,
      activeWorkspaceExecutionHostId: props.activeWorkspaceExecutionHostId,
      currentWorktreeId: props.currentWorktreeId,
      highlightedRevealRowKey: reveal.highlightedRevealRowKey,
      selectedWorktreeIds: props.selectedWorktreeIds,
      selectedWorktrees: props.selectedWorktrees,
      getActiveSurfaceVariant: primaryActive.getActiveSurfaceVariant,
      getLineageToggleHandler: args.getLineageToggleHandler,
      onSelectionGesture: props.onSelectionGesture,
      onContextMenuSelect: props.onContextMenuSelect,
      onImmediateActivate: primaryActive.handleImmediateWorktreeRowActivate,
      onRowClickCapture: args.onRowClickCapture,
      onRowPointerDown: args.onRowPointerDown,
      onCardDragStart: args.nativeDrag.handleWorktreeCardDragStart,
      onCardDragEnd: runtime.clearWorktreeDrag
    },
    folderWorkspace: {
      groupBy: props.groupBy,
      newCardStyle: args.newCardStyle,
      settings: args.settings,
      activeWorktreeId: props.activeWorktreeId,
      currentWorktreeId: props.currentWorktreeId,
      selectedWorktreeIds: props.selectedWorktreeIds,
      repoMap: props.repoMap,
      worktreeMap: props.worktreeMap,
      worktreeLineageById: props.worktreeLineageById,
      workspaceLineageByChildKey: props.workspaceLineageByChildKey,
      prCache: props.prCache,
      hostedReviewCache: props.hostedReviewCache,
      getCachedFolderWorkspacePathStatus: args.getCachedFolderWorkspacePathStatus,
      onSelectionGesture: props.onSelectionGesture,
      onContextMenuSelect: props.onContextMenuSelect,
      onImmediateActivate: primaryActive.handleImmediateWorktreeRowActivate,
      onRowClickCapture: args.onRowClickCapture,
      onRowPointerDown: args.onRowPointerDown
    }
  }
}
