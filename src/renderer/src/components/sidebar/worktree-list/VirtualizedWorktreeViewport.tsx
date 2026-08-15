import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { WorktreeSidebarDropIndicator } from '../WorktreeSidebarDropIndicator'
import { WorktreeListScrollToTopButton } from '../WorktreeListScrollToTopButton'
import { useWorktreeListScrollToTop } from '../use-worktree-list-scroll-to-top'
import { getActiveDescendantOptionId } from './active-descendant-option'
import { buildRenderableRows } from './renderable-rows'
import { useFolderWorkspacePathStatusRows } from './use-folder-workspace-path-status-rows'
import { useGroupToggleWithScrollAnchor } from './use-group-toggle-with-scroll-anchor'
import { usePendingSidebarReveal } from './use-pending-sidebar-reveal'
import { usePrimaryActiveWorktreeRow } from './use-primary-active-worktree-row'
import { useSidebarRevealHighlight } from './use-sidebar-reveal-highlight'
import { useVirtualRowMeasurementSync } from './use-virtual-row-measurement-sync'
import { useVisiblePrRefreshReporting } from './use-visible-pr-refresh-reporting'
import { useWorkspaceStatusRowDrag } from './use-workspace-status-row-drag'
import { useWorktreeDragRuntime } from './use-worktree-drag-runtime'
import { useWorktreeDragSession } from './use-worktree-drag-session'
import { useWorktreeDocumentDrop } from './use-worktree-document-drop'
import { useWorktreeLineageDropCommit } from './use-worktree-lineage-drop-commit'
import { useWorktreeListKeyboardNavigation } from './use-worktree-list-keyboard-navigation'
import { useWorktreeListVirtualizer } from './use-worktree-list-virtualizer'
import { useWorktreeNativeDrag } from './use-worktree-native-drag'
import { useWorktreePointerDrag } from './use-worktree-pointer-drag'
import { useWorktreeSidebarHeaderDrag } from './use-worktree-sidebar-header-drag'
import { useWorktreeSidebarScrollSuppression } from './use-worktree-sidebar-scroll-suppression'
import {
  EMPTY_PROJECT_GROUPS,
  type VirtualizedWorktreeViewportProps
} from './virtualized-worktree-viewport-props'
import { WORKTREE_SIDEBAR_SCROLL_STYLE } from './worktree-sidebar-scroll-tuning'
import type { WorktreeDropCommitContext } from './worktree-drop-commit-context'
import { buildWorktreeVirtualRowContext } from './worktree-virtual-row-context'
import { renderWorktreeVirtualRow } from './worktree-virtual-row-dispatch'

export const VirtualizedWorktreeViewport = React.memo(function VirtualizedWorktreeViewport(
  props: VirtualizedWorktreeViewportProps
) {
  const {
    rows,
    groupBy,
    pinnedDisplayPolicy,
    activeWorktreeId,
    collapsedGroups,
    toggleGroup,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    workspaceStatuses,
    projectGroups = EMPTY_PROJECT_GROUPS,
    scrollOffsetRef,
    scrollAnchorRef
  } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  // Why: callback-ref only mutates scrollRef; state re-runs the scroll-to-top listener attach.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const settings = useAppStore((s) => s.settings)
  const worktreeVisibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const newCardStyle = settings?.experimentalNewWorktreeCardStyle === true

  const reveal = useSidebarRevealHighlight()
  const scrollSuppression = useWorktreeSidebarScrollSuppression(scrollRef)
  const { markDirectScrollInput, markScrollMovement } = scrollSuppression

  const renderRows = useMemo(() => buildRenderableRows(rows), [rows])
  const firstHeaderIndex = useMemo(
    () => renderRows.findIndex((row) => row.type === 'header' || row.type === 'host-header'),
    [renderRows]
  )
  const folderBackedProjectGroupIds = useMemo(
    () =>
      new Set(
        projectGroups
          .filter((group) => group.createdFrom === 'folder-scan')
          .map((group) => group.id)
      ),
    [projectGroups]
  )

  const headerDrag = useWorktreeSidebarHeaderDrag({
    rows,
    renderRows,
    firstHeaderIndex,
    allRepoIds: props.allRepoIds,
    repoMap,
    projectGroups,
    groupBy,
    projectOrderBy: props.projectOrderBy,
    scrollRef,
    onReorderHostSections: props.onReorderHostSections,
    onHostDragActiveChange: props.onHostDragActiveChange,
    suppressMeasurementAdjustmentUntilRef: scrollSuppression.suppressMeasurementAdjustmentUntilRef,
    directScrollInputUntilRef: scrollSuppression.directScrollInputUntilRef
  })

  const session = useWorktreeDragSession({ rows, scrollRef })
  const lineageDrop = useWorktreeLineageDropCommit({
    repoMap,
    worktreeMap,
    worktreeLineageById,
    worktreeDragGroups: session.worktreeDragGroups
  })
  const runtime = useWorktreeDragRuntime({
    worktreeDragSessionRef: session.worktreeDragSessionRef,
    statusDropAnchorsRef: session.statusDropAnchorsRef,
    onWorkspaceBoardDragPreviewCancel: props.onWorkspaceBoardDragPreviewCancel
  })

  const primaryActive = usePrimaryActiveWorktreeRow({
    rows,
    activeWorktreeId,
    pinnedDisplayPolicy,
    onImmediateWorktreeActivate: props.onImmediateWorktreeActivate
  })

  const getCachedFolderWorkspacePathStatus = useFolderWorkspacePathStatusRows({
    allRepoIds: props.allRepoIds,
    repoMap,
    projectGroups,
    folderWorkspaces: props.folderWorkspaces,
    sshConnectionStates
  })

  const { showScrollToTop, scrollToTop } = useWorktreeListScrollToTop({
    scrollElement,
    onUserScrollIntent: markDirectScrollInput
  })

  const virtualization = useWorktreeListVirtualizer({
    renderRows,
    firstHeaderIndex,
    scrollRef,
    scrollOffsetRef,
    suppressMeasurementAdjustmentUntilRef: scrollSuppression.suppressMeasurementAdjustmentUntilRef
  })

  usePendingSidebarReveal({
    pendingRevealWorktree: props.pendingRevealWorktree,
    pendingRevealSidebarRow: props.pendingRevealSidebarRow,
    clearPendingRevealWorktreeId: props.clearPendingRevealWorktreeId,
    clearPendingRevealSidebarRow: props.clearPendingRevealSidebarRow,
    agentSendTargetWorktreeId: props.agentSendTargetWorktreeId,
    renderRows,
    virtualizer: virtualization.virtualizer,
    scrollRef,
    worktrees: props.worktrees,
    folderWorkspaces: props.folderWorkspaces,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    collapsedGroups,
    toggleGroup,
    groupBy,
    pinnedDisplayPolicy,
    defaultHostId: props.defaultHostId,
    prCache: props.prCache,
    workspaceStatuses,
    settings,
    projectGroups,
    projectGrouping: props.projectGrouping,
    flashRevealedRow: reveal.flashRevealedRow,
    markRevealScroll: scrollSuppression.markRevealScroll,
    schedulePendingRevealFrame: reveal.schedulePendingRevealFrame,
    cancelPendingRevealFrames: reveal.cancelPendingRevealFrames
  })

  const { virtualItems, measureVirtualRowElement } = useVirtualRowMeasurementSync({
    renderRows,
    virtualization,
    scrollRef,
    scrollOffsetRef,
    scrollAnchorRef,
    hasDirectScrollInput: scrollSuppression.hasDirectScrollInput,
    shouldSkipScrollAnchorRestore: scrollSuppression.shouldSkipScrollAnchorRestore
  })

  const { toggleGroupWithScrollAnchor, getLineageToggleHandler } = useGroupToggleWithScrollAnchor({
    scrollRef,
    toggleGroup
  })

  const { handleContainerKeyDown } = useWorktreeListKeyboardNavigation({
    rows,
    renderRows,
    activeWorktreeId,
    pinnedDisplayPolicy,
    virtualizer: virtualization.virtualizer,
    scrollRef,
    activeModal: props.activeModal,
    markDirectScrollInput
  })

  const dropCtx = useMemo<WorktreeDropCommitContext>(
    () => ({
      scrollRef,
      workspaceStatuses,
      worktreeDragGroups: session.worktreeDragGroups,
      worktreeDragUnitGroups: session.worktreeDragUnitGroups,
      computeWorktreeDrop: session.computeWorktreeDrop,
      computeWorktreeStatusDrop: session.computeWorktreeStatusDrop,
      refreshWorktreeDragSession: session.refreshWorktreeDragSession,
      getEligibleLineageDropTarget: lineageDrop.getEligibleLineageDropTarget,
      commitWorktreeLineageParentDrop: lineageDrop.commitWorktreeLineageParentDrop,
      clearReorderedWorktreeParents: lineageDrop.clearReorderedWorktreeParents,
      clearWorktreeDrag: runtime.clearWorktreeDrag,
      onMoveWorktreesToStatus: props.onMoveWorktreesToStatus,
      onMoveWorktreesToStatusAtIndex: props.onMoveWorktreesToStatusAtIndex,
      onReorderWorktrees: props.onReorderWorktrees,
      onPinWorktrees: props.onPinWorktrees
    }),
    [
      lineageDrop.clearReorderedWorktreeParents,
      lineageDrop.commitWorktreeLineageParentDrop,
      lineageDrop.getEligibleLineageDropTarget,
      props.onMoveWorktreesToStatus,
      props.onMoveWorktreesToStatusAtIndex,
      props.onPinWorktrees,
      props.onReorderWorktrees,
      runtime.clearWorktreeDrag,
      session.computeWorktreeDrop,
      session.computeWorktreeStatusDrop,
      session.refreshWorktreeDragSession,
      session.worktreeDragGroups,
      session.worktreeDragUnitGroups,
      workspaceStatuses
    ]
  )

  const { handleWorktreeRowPointerDown, handleWorktreeRowClickCapture } = useWorktreePointerDrag({
    ctx: dropCtx,
    session,
    runtime,
    scrollRef,
    markScrollMovement,
    selectedWorktreeIds: props.selectedWorktreeIds,
    selectedWorktrees: props.selectedWorktrees,
    workspaceBoardOpen: props.workspaceBoardOpen,
    onWorkspaceBoardDragPreviewStart: props.onWorkspaceBoardDragPreviewStart,
    onWorkspaceBoardDragPreviewCommit: props.onWorkspaceBoardDragPreviewCommit,
    onDropWorktreesOnWorkspaceBoard: props.onDropWorktreesOnWorkspaceBoard,
    shouldShowWorkspaceBoardDropIndicator: props.shouldShowWorkspaceBoardDropIndicator
  })
  const nativeDrag = useWorktreeNativeDrag({
    ctx: dropCtx,
    session,
    runtime,
    scrollRef,
    markScrollMovement
  })
  useWorktreeDocumentDrop({
    ctx: dropCtx,
    worktreeDragSessionRef: session.worktreeDragSessionRef
  })
  const statusDrag = useWorkspaceStatusRowDrag({
    ctx: dropCtx,
    session,
    runtime,
    scrollRef,
    rows,
    groupBy,
    onMoveWorktreeToStatus: props.onMoveWorktreeToStatus,
    onPinWorktree: props.onPinWorktree
  })

  useVisiblePrRefreshReporting({
    currentWorktreeId: props.currentWorktreeId,
    worktreeMap,
    groupBy,
    newCardStyle,
    renderRows,
    virtualItems,
    scrollRef
  })

  // Why: a callback ref that changes identity is re-invoked with null on every render, which
  // would run the teardown below mid-drag; depend only on the stable teardown callbacks.
  const { cancelPendingRevealFrames, clearRevealHighlightFrame, clearRevealHighlightTimeout } =
    reveal
  const { clearWorktreeDrag } = runtime
  const setScrollRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null && scrollRef.current !== null) {
        // Why: drag previews, autoscroll frames, and reveal snapshots are tied to the scroll root; clear them before it unmounts.
        cancelPendingRevealFrames()
        clearRevealHighlightFrame()
        clearRevealHighlightTimeout()
        clearWorktreeDrag()
      }
      scrollRef.current = node
      setScrollElement(node)
    },
    [
      cancelPendingRevealFrames,
      clearRevealHighlightFrame,
      clearRevealHighlightTimeout,
      clearWorktreeDrag
    ]
  )
  const handleScrollPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const scrollbarWidth = event.currentTarget.offsetWidth - event.currentTarget.clientWidth
      if (scrollbarWidth <= 0) {
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX >= rect.right - scrollbarWidth) {
        markDirectScrollInput()
      }
    },
    [markDirectScrollInput]
  )
  const handleScroll = useCallback(() => {
    markScrollMovement()
  }, [markScrollMovement])

  const rowContext = buildWorktreeVirtualRowContext({
    props,
    renderRows,
    firstHeaderIndex,
    virtualization,
    measureVirtualRowElement,
    settings,
    worktreeVisibilityDefaultsByHost,
    sshConnectionStates,
    newCardStyle,
    folderBackedProjectGroupIds,
    projectGroups,
    session,
    runtime,
    primaryActive,
    reveal,
    statusDrag,
    nativeDrag,
    headerDrag,
    getCachedFolderWorkspacePathStatus,
    getLineageToggleHandler,
    toggleGroupWithScrollAnchor,
    onRowClickCapture: handleWorktreeRowClickCapture,
    onRowPointerDown: handleWorktreeRowPointerDown
  })

  return (
    <div
      data-worktree-sidebar-container
      data-contextual-tour-target="workspace-list"
      className="relative min-h-0 flex-1"
    >
      <div
        ref={setScrollRootRef}
        data-worktree-sidebar
        tabIndex={0}
        role="listbox"
        aria-label={translate('auto.components.sidebar.WorktreeList.bfbedc547b', 'Worktrees')}
        aria-orientation="vertical"
        aria-multiselectable="true"
        aria-activedescendant={getActiveDescendantOptionId({
          activeWorktreeId,
          primaryActiveRowKey:
            primaryActive.primaryActiveWorktreeRow?.worktreeId === activeWorktreeId
              ? primaryActive.primaryActiveWorktreeRow.rowKey
              : undefined,
          pinnedDisplayPolicy,
          renderRows,
          virtualItems
        })}
        onKeyDown={handleContainerKeyDown}
        // Why: trackpad momentum fires sparse scroll events after the input stream quiets; suppress correction until the viewport stops.
        onScroll={handleScroll}
        onPointerDown={handleScrollPointerDown}
        onTouchMove={markDirectScrollInput}
        onWheel={markDirectScrollInput}
        onDragOver={nativeDrag.handleWorktreeDragOver}
        onDrop={nativeDrag.handleWorktreeDrop}
        className="worktree-sidebar-scrollbar h-full overflow-y-auto overflow-x-hidden pl-1 scrollbar-sleek outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset pt-px"
        style={WORKTREE_SIDEBAR_SCROLL_STYLE}
      >
        <div
          role="presentation"
          className="relative w-full"
          style={{ height: `${virtualization.virtualizer.getTotalSize()}px` }}
        >
          {headerDrag.canReorderRepoHeaders &&
          headerDrag.repoDrag.state.draggingRepoId !== null &&
          headerDrag.repoDrag.state.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator y={headerDrag.repoDrag.state.dropIndicatorY} />
          ) : null}
          {headerDrag.canReorderProjectGroupHeaders &&
          headerDrag.projectGroupDrag.state.draggingGroupId !== null &&
          headerDrag.projectGroupDrag.state.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator y={headerDrag.projectGroupDrag.state.dropIndicatorY} />
          ) : null}
          {headerDrag.hostDrag.state.draggingHostId !== null &&
          headerDrag.hostDrag.state.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator
              y={headerDrag.hostDrag.state.dropIndicatorY}
              className="z-40"
            />
          ) : null}
          {runtime.worktreeDragState.draggingWorktreeId !== null &&
          runtime.worktreeDragState.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator y={runtime.worktreeDragState.dropIndicatorY} />
          ) : null}
          {virtualItems.map((vItem) => {
            const row = renderRows[vItem.index]
            return row ? renderWorktreeVirtualRow(rowContext, row, vItem) : null
          })}
        </div>
      </div>
      {showScrollToTop ? <WorktreeListScrollToTopButton onClick={scrollToTop} /> : null}
    </div>
  )
})
