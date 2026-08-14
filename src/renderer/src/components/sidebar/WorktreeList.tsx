/* eslint-disable max-lines */
import React, { useMemo, useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react'
import { toast } from 'sonner'
import { CircleX } from 'lucide-react'
import { useAppStore } from '@/store'
import { createLineageToggleHandlerCache } from './worktree-lineage-toggle-handler-cache'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import { useShallow } from 'zustand/react/shallow'
import type { AppState } from '@/store/types'
import {
  useAllWorktrees,
  useProjectHostSetupProjection,
  useRepoMap,
  useWorktreeMap
} from '@/store/selectors'
import { WorktreeSidebarDropIndicator } from './WorktreeSidebarDropIndicator'
import {
  getProjectGroupHeaderSectionEndByGroupId,
  getRepoHeaderSectionEndByRepoId
} from './worktree-header-section-boundaries'
import { SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT } from './WorktreeCardAgents'
import { cn } from '@/lib/utils'
import type {
  Worktree,
  Repo,
  ProjectGroup,
  WorktreeMeta,
  WorkspaceStatus
} from '../../../../shared/types'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import { deriveRunningAgentSendTargets } from '@/lib/running-agent-targets'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'
import {
  type Row,
  PINNED_GROUP_KEY,
  buildRows,
  getGroupKeysForWorktree,
  getLineageGroupKey,
  getPinnedWorktreeDisplayPolicy
} from './worktree-list-groups'
import {
  getActiveStickyIndexesForScroll,
  getRenderRowKey,
  getStickyHeaderIndexes,
  getVirtualRowTransform,
  shouldUseHeaderTopSpacing,
  WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP
} from './worktree-list-virtual-rows'
import {
  createPendingRevealScroll,
  isRevealScrollSettling,
  type PendingRevealScroll
} from './worktree-sidebar-reveal-scroll-settle'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from './workspace-status'
import { useWorkspaceStatusDocumentDrop } from './use-workspace-status-drop'
import {
  computeClearFilterActions,
  computeVisibleWorktreeIds,
  setVisibleWorktreeIds,
  sidebarHasActiveFilters
} from './visible-worktrees'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  filterFolderWorkspacesFromOtherDevices,
  getPairedDeviceIdsByEnvironment
} from './workspace-creator-visibility'
import {
  getCyclicProjectedWorktreeLineageIds,
  getWorktreeLineageAncestors
} from './worktree-lineage-projection'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import { getEmptyProjectPlaceholderRepoIds } from './empty-project-placeholder-repos'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs
} from './visible-worktree-activity-inputs'
import { selectWorktreeListReviewCacheInputs } from './worktree-list-review-cache-inputs'
import {
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT,
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { useWorktreeListScrollToTop } from './use-worktree-list-scroll-to-top'
import { WorktreeListScrollToTopButton } from './WorktreeListScrollToTopButton'
import {
  SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
  type ScrollToCurrentWorkspaceRevealRequestDetail
} from '@/lib/scroll-to-current-workspace-status'
import { useRepoHeaderDrag } from './project-header-drag'
import {
  getLogicalRepoOrderRankById,
  getSidebarOrderedRepoHeaderIdsByBucket
} from './project-header-drop'
import { useProjectGroupHeaderDrag } from './project-group-header-drag'
import { getSidebarOrderedProjectGroupHeaderIdsByBucket } from './project-group-header-drop'
import {
  buildManualOrderUpdatesForGroupDrop,
  buildManualOrderUpdatesForVisibleGroups,
  expandDraggedWorktreeIdsForVisibleLineage,
  shouldWriteManualOrderForGroupDrop,
  type WorktreeDragGroup
} from './worktree-manual-order'
import {
  buildWorkspaceKanbanSidebarDropUpdates,
  clearWorkspaceKanbanSidebarDropTargetVisual
} from './workspace-kanban-sidebar-drop'
import { getWorktreeDragUnitGroups } from './worktree-drag-units'
import { setSidebarPointerDragDocumentStyles } from './worktree-sidebar-pointer-drag-dom'
import {
  getWorktreeSidebarDragRectsForGroup,
  refreshWorktreeSidebarDragSession,
  type WorktreeSidebarDragRect,
  type WorktreeSidebarDragSession,
  type WorktreeSidebarDragPoint
} from './worktree-sidebar-drag-autoscroll'
import {
  shouldReevaluateWorktreeSidebarDropAnchor,
  type WorktreeSidebarDragGrab,
  type WorktreeSidebarDropAnchor
} from './worktree-sidebar-drag-geometry'
import {
  computeWorktreeSidebarDropPreview,
  type WorktreeSidebarStatusDropTarget,
  type WorktreeSidebarDropPreview
} from './worktree-sidebar-drop-preview'
import { getReorderedWorktreeIdsToUnnest } from './worktree-lineage-drag-drop'
import {
  areWorktreeSelectionsEqual,
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeSelection
} from './worktree-multi-selection'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { ProjectGroupDeleteDialog } from './ProjectGroupDeleteDialog'
import { selectProjectGroupRemovalTargets } from '@/store/slices/project-group-removal-targets'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import SuppressExternalWorktreeInboxDialog from './SuppressExternalWorktreeInboxDialog'
import {
  keepImportedWorktreesHiddenCard,
  IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR,
  showImportedWorktreesCard,
  type ImportedWorktreeCardActionState
} from './imported-worktrees-card-actions'
import {
  suppressNewExternalWorktreeInbox,
  type NewExternalWorktreesInboxActionState
} from './new-external-worktrees-inbox-actions'
import { isEligibleWorktreeParent } from './worktree-parent-candidates'
import {
  buildImportedWorktreesCardCandidates,
  getHiddenImportedWorktrees
} from './imported-worktrees-card-candidates'
import { buildNewExternalWorktreesInboxCandidates } from './new-external-worktrees-inbox-candidates'
import { addHostSectionRows, type HostHeaderRow } from './host-section-rows'
import { orderHostSectionOptions } from './host-section-order'
import { useHostHeaderDrag } from './host-header-drag'
import { buildSidebarHostOptions } from './sidebar-host-options'
import { translate } from '@/i18n/i18n'
import { folderWorkspaceKey, getActiveSidebarWorkspaceId } from '../../../../shared/workspace-scope'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getKnownSidebarWorktreeById } from './worktree-list-folder-reveal'
import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts,
  getVisibleSidebarHostIdSet
} from './worktree-list-host-filtering'
import { getRenderedWorktreesInSidebarOrder } from './worktree-sidebar-row-preference'
import { installWorktreeVisibleRefreshVisibilityListener } from './worktree-list-behavior'
import { markSidebarWorktreeActiveImmediately } from './worktree-list-dom-activation'
import {
  buildRenderableRows,
  getActiveDescendantOptionId,
  getWorktreeDragGroups,
  type WorktreeItemRow
} from './worktree-list-render-row-model'
import { getWorktreeDragIndexes } from './worktree-list-drag-indexes'
import {
  getVirtualRowKey,
  getWorktreeVirtualRowTransform,
  uniqueWorktreeIds,
  WORKTREE_ROW_DRAG_INITIAL_STATE,
  type WorktreePointerDrag,
  type WorktreeRowDragState
} from './worktree-list-drag-model'
import type { VirtualizedWorktreeViewportProps } from './worktree-list-viewport-types'
import { WorktreeListHostSectionHeader } from './WorktreeListHostSectionHeader'
import { WorktreeListSectionHeader } from './WorktreeListSectionHeader'
import { getWorktreeListSectionHeaderModel } from './worktree-list-section-header-model'
import { useWorktreeListWorkspaceReveal } from './use-worktree-list-workspace-reveal'
import { useWorktreeListSidebarRowReveal } from './use-worktree-list-sidebar-row-reveal'
import { useWorktreePointerDragFlush } from './use-worktree-pointer-drag-flush'
import { useWorktreePointerDragController } from './use-worktree-pointer-drag-controller'
import { useWorktreePointerDragCommit } from './use-worktree-pointer-drag-commit'
import { useWorktreeStatusDropHandlers } from './use-worktree-status-drop-handlers'
import { useWorktreeNativeDropEffects } from './use-worktree-native-drop-effects'
import { useWorktreeVisibleReviewRefresh } from './use-worktree-visible-review-refresh'
import { useWorktreeNativeDragStart } from './use-worktree-native-drag-start'
import { useWorktreeNativeDragHandlers } from './use-worktree-native-drag-handlers'
import { WorktreeListWorktreeRow } from './WorktreeListWorktreeRow'
import { WorktreeListFolderWorkspaceRow } from './WorktreeListFolderWorkspaceRow'
import { useWorktreeListSmartOrder } from './use-worktree-list-smart-order'
import { WorktreeListAuxiliaryRow } from './WorktreeListAuxiliaryRows'
import { useWorktreeListRevealHighlight } from './use-worktree-list-reveal-highlight'
import { useWorktreeFolderPathStatuses } from './use-worktree-folder-path-statuses'
import { useWorktreeListKeyboard } from './use-worktree-list-keyboard'
import { useWorktreeVirtualRowMeasurement } from './use-worktree-virtual-row-measurement'
import { useWorktreeActiveRow } from './use-worktree-active-row'
import { useWorktreeListVirtualizer } from './use-worktree-list-virtualizer'

export {
  countRecordKeysByReference,
  installWorktreeVisibleRefreshVisibilityListener,
  resolvePendingSidebarReveal,
  shouldAdjustWorktreeSidebarMeasuredRowScroll
} from './worktree-list-behavior'
export {
  canKeepImportedWorktreesHidden,
  getPinnedWorktreeRevealCollapsedGroupKeys,
  getWorktreeDragGroups,
  renderRowContainsWorktree
} from './worktree-list-render-row-model'
export { getWorktreeDragIndexes } from './worktree-list-drag-indexes'

export {
  getScrollTopToRevealBounds,
  WORKTREE_SIDEBAR_REVEAL_TOP_INSET
} from './worktree-sidebar-reveal'

type ProjectGroupNameDialogState =
  | { type: 'create-from-repo'; repo: Repo }
  | { type: 'rename'; groupId: string; currentName: string }

type ProjectGroupDeleteDialogState = {
  groupId: string
  groupName: string
  removeContainedProjects: boolean
}

const USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS = 500
const EMPTY_PROJECT_GROUPS: readonly ProjectGroup[] = []
const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = {}
const EMPTY_WORKTREE_ID_SET: ReadonlySet<string> = new Set()
const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: AppState['terminalLayoutsByTabId'] = {}
const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
const EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID: AppState['runtimePaneTitlesByTabId'] = {}
const EXPANDING_CARD_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS = 300
const NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK = (): void => {}
const WORKTREE_SIDEBAR_SCROLL_STYLE: React.CSSProperties = {
  // Why: TanStack Virtual owns scroll correction; native overflow anchoring fights it and causes jumps.
  overflowAnchor: 'none'
}

// Why: getRenderRowKey lives with the other virtual-row helpers now; keep the
// long-standing import path working for callers that reach for it here.
export { getRenderRowKey }

const VirtualizedWorktreeViewport = React.memo(function VirtualizedWorktreeViewport({
  rows,
  activeWorktreeId,
  currentWorktreeId,
  groupBy,
  pinnedDisplayPolicy,
  projectOrderBy,
  toggleGroup,
  collapsedGroups,
  handleCreateForRepo,
  handleOpenRepoSettings,
  handleOpenWorktreeVisibility,
  handleShowImportedWorktrees,
  handleKeepImportedWorktreesHidden,
  importedWorktreeCardActionState,
  handleOpenSuppressExternalWorktreeInbox,
  newExternalWorktreeInboxActionState,
  handleRemoveProject,
  handleCreateGroupFromRepo,
  handleMoveProjectToGroup,
  handleRemoveProjectFromGroup,
  handleRenameProjectGroup,
  handleDeleteProjectGroup,
  handleCreateFolderWorkspace,
  activeModal,
  pendingRevealWorktree,
  pendingRevealSidebarRow,
  clearPendingRevealWorktreeId,
  clearPendingRevealSidebarRow,
  agentSendTargetWorktreeId,
  worktrees,
  folderWorkspaces,
  selectedWorktreeIds,
  selectedWorktrees,
  onSelectionGesture,
  onImmediateWorktreeActivate,
  onContextMenuSelect,
  repoMap,
  defaultHostId,
  worktreeMap,
  worktreeLineageById,
  workspaceLineageByChildKey,
  allRepoIds,
  onReorderHostSections,
  onHostDragActiveChange,
  prCache,
  hostedReviewCache,
  workspaceStatuses,
  projectGrouping,
  projectGroups = EMPTY_PROJECT_GROUPS,
  onMoveWorktreeToStatus,
  onMoveWorktreesToStatus,
  onMoveWorktreesToStatusAtIndex,
  onPinWorktree,
  onPinWorktrees,
  onDropWorktreesOnWorkspaceBoard,
  workspaceBoardOpen,
  onWorkspaceBoardDragPreviewStart,
  onWorkspaceBoardDragPreviewCommit,
  onWorkspaceBoardDragPreviewCancel,
  shouldShowWorkspaceBoardDropIndicator,
  onReorderWorktrees,
  scrollOffsetRef,
  scrollAnchorRef
}: VirtualizedWorktreeViewportProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Why: callback-ref only mutates scrollRef; state re-runs the scroll-to-top listener attach.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const suppressMeasurementAdjustmentUntilRef = useRef(0)
  const directScrollInputUntilRef = useRef(0)
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)
  const [nativeLineageDropTargetId, setNativeLineageDropTargetId] = useState<string | null>(null)
  const [worktreeDragState, setWorktreeDragState] = useState<WorktreeRowDragState>(
    WORKTREE_ROW_DRAG_INITIAL_STATE
  )
  const [pendingRevealRetryTick, setPendingRevealRetryTick] = useState(0)
  const [documentVisibilityRevision, setDocumentVisibilityRevision] = useState(0)
  const setRenamingWorktreeId = useAppStore((s) => s.setRenamingWorktreeId)
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const cyclicLineageIds = useMemo(
    () => getCyclicProjectedWorktreeLineageIds(worktreeLineageById, worktreeMap),
    [worktreeLineageById, worktreeMap]
  )
  const worktreeDragSessionRef = useRef<WorktreeSidebarDragSession | null>(null)
  // Why: cross-group hovers hit-test a group the session never captured, so hold
  // that group's drop decision separately or a card expanding in the target group
  // moves the insertion line under a still pointer.
  const statusDropAnchorsRef = useRef<Map<string, WorktreeSidebarDropAnchor>>(new Map())
  const worktreePointerDragRef = useRef<WorktreePointerDrag | null>(null)
  const worktreePointerAutoscrollFrameIdRef = useRef<number | null>(null)
  const worktreePointerAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const worktreeNativeAutoscrollFrameIdRef = useRef<number | null>(null)
  const worktreeNativeAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const worktreeNativeLatestPointRef = useRef<WorktreeSidebarDragPoint | null>(null)
  const pendingRevealRetryRef = useRef<{ worktreeId: string; count: number } | null>(null)
  const pendingRowRevealRetryRef = useRef<{ rowKey: string; count: number } | null>(null)
  const pendingRevealScrollRef = useRef<PendingRevealScroll | null>(null)
  const {
    highlightedRevealRowKey,
    flashRevealedRow,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    clearRevealHighlight
  } = useWorktreeListRevealHighlight()
  const suppressWorktreeClickUntilRef = useRef(0)
  const hasProjectGroups = projectGroups.length > 0
  const canReorderRepoHeaders = groupBy === 'repo' && projectOrderBy === 'manual'
  const canReorderProjectGroupHeaders = groupBy === 'repo' && hasProjectGroups
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const lastVisibleRefreshKeyRef = useRef('')
  const reportVisibleGitHubPRRefreshCandidates = useAppStore(
    (s) => s.reportVisibleGitHubPRRefreshCandidates
  )
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const rightSidebarShowsPR = useAppStore((s) => rightSidebarShowsPullRequestData(s))
  const keybindings = useAppStore((s) => s.keybindings)
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const prVisibleRefreshGeneration = useAppStore((s) => s.prVisibleRefreshGeneration)
  const settings = useAppStore((s) => s.settings)
  const newCardStyle = settings?.experimentalNewWorktreeCardStyle === true
  const reorderRepos = useAppStore((s) => s.reorderRepos)
  const folderBackedProjectGroupIds = useMemo(
    () =>
      new Set(
        projectGroups
          .filter((group) => group.createdFrom === 'folder-scan')
          .map((group) => group.id)
      ),
    [projectGroups]
  )
  const projectGroupByIdForHeaderDrag = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  )

  useEffect(
    () =>
      installWorktreeVisibleRefreshVisibilityListener(() => {
        if (document.visibilityState !== 'visible') {
          // Why: row identity may be unchanged after a hidden window; reset the key so PR/CI rows refresh.
          lastVisibleRefreshKeyRef.current = '__document_hidden__'
          return
        }
        setDocumentVisibilityRevision((revision) => revision + 1)
      }),
    []
  )

  // Why: reorder keeps scrollTop stable; flag direct scroll input so anchor-restore won't chase the moved row (jumpy drop).
  const commitRepoReorder = useCallback(
    (orderedIds: string[]) => {
      const suppressUntil =
        window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
      suppressMeasurementAdjustmentUntilRef.current = suppressUntil
      directScrollInputUntilRef.current = suppressUntil
      reorderRepos(orderedIds)
    },
    [reorderRepos]
  )
  const orderedHostIds = useMemo(
    () =>
      rows
        .filter((row): row is HostHeaderRow => row.type === 'host-header')
        .map((row) => row.hostId),
    [rows]
  )
  const hostDrag = useHostHeaderDrag({
    orderedHostIds,
    onCommit: onReorderHostSections,
    getScrollContainer: () => scrollRef.current
  })
  useEffect(() => {
    onHostDragActiveChange(hostDrag.state.draggingHostId !== null)
  }, [hostDrag.state.draggingHostId, onHostDragActiveChange])
  useEffect(() => () => onHostDragActiveChange(false), [onHostDragActiveChange])
  const worktreeDragGroups = useMemo(() => getWorktreeDragGroups(rows), [rows])
  const worktreeDragUnitGroups = useMemo(() => getWorktreeDragUnitGroups(rows), [rows])
  const naturalDragWorktreeIds = useMemo(
    () =>
      new Set(
        rows.flatMap((row) =>
          row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY ? [row.worktree.id] : []
        )
      ),
    [rows]
  )
  const worktreeLineageDragRows = useMemo(
    () =>
      rows
        .filter((row): row is WorktreeItemRow => row.type === 'item')
        .filter(
          (row) =>
            row.sectionKey !== PINNED_GROUP_KEY || !naturalDragWorktreeIds.has(row.worktree.id)
        )
        .map((row) => ({ worktreeId: row.worktree.id, depth: row.depth })),
    [naturalDragWorktreeIds, rows]
  )
  const getReorderDraggedIds = useCallback(
    (draggedIds: readonly string[]) =>
      expandDraggedWorktreeIdsForVisibleLineage(worktreeLineageDragRows, draggedIds),
    [worktreeLineageDragRows]
  )
  const getReorderUnitDraggedIds = useCallback(
    (sourceGroupKey: string, reorderDraggedIds: readonly string[]) => {
      const group = worktreeDragUnitGroups.find((candidate) => candidate.key === sourceGroupKey)
      if (!group) {
        return reorderDraggedIds
      }
      const unitIds = new Set(group.worktreeIds)
      const filtered = reorderDraggedIds.filter((worktreeId) => unitIds.has(worktreeId))
      return filtered.length > 0 ? filtered : reorderDraggedIds
    },
    [worktreeDragUnitGroups]
  )
  const { groupKeyByRowKey, groupIndexByRowKey } = useMemo(
    () => getWorktreeDragIndexes(rows),
    [rows]
  )
  const refreshWorktreeDragSession = useCallback((): boolean => {
    const session = worktreeDragSessionRef.current
    const container = scrollRef.current
    if (!session || !container) {
      return false
    }

    const refreshedSession = refreshWorktreeSidebarDragSession({
      session,
      groups: worktreeDragGroups,
      unitGroups: worktreeDragUnitGroups,
      rects: getWorktreeSidebarDragRectsForGroup(container, session.sourceGroupKey)
    })
    worktreeDragSessionRef.current = refreshedSession
    return refreshedSession !== null
  }, [worktreeDragGroups, worktreeDragUnitGroups])
  const computeWorktreeDropForGroup = useCallback(
    (args: {
      pointerY: number
      groupKey: string
      rects: readonly WorktreeSidebarDragRect[]
      draggedIds: readonly string[]
      draggingWorktreeId?: string | null
      grab?: WorktreeSidebarDragGrab | null
      anchor?: WorktreeSidebarDropAnchor | null
    }): WorktreeSidebarDropPreview | null => {
      const container = scrollRef.current
      if (!container) {
        return null
      }
      const group = worktreeDragUnitGroups.find((candidate) => candidate.key === args.groupKey)
      if (!group) {
        return null
      }
      const containerRect = container.getBoundingClientRect()
      return computeWorktreeSidebarDropPreview({
        pointerY: args.pointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        rects: args.rects,
        groupIds: group.worktreeIds,
        draggedIds: args.draggedIds,
        draggingWorktreeId: args.draggingWorktreeId,
        fallbackGap: WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP,
        grab: args.grab,
        anchor: args.anchor
      })
    },
    [worktreeDragUnitGroups]
  )
  const computeWorktreeDrop = useCallback(
    (pointerY: number): WorktreeSidebarDropPreview | null => {
      const session = worktreeDragSessionRef.current
      const container = scrollRef.current
      if (!session || !container) {
        return null
      }
      const scrollTop = container.scrollTop
      // Why: only real pointer or scroll movement should re-decide the slot; a
      // card growing under a still pointer must not move it.
      const anchor = shouldReevaluateWorktreeSidebarDropAnchor({
        anchor: session.anchor,
        pointerY,
        scrollTop
      })
        ? null
        : session.anchor
      const preview = computeWorktreeDropForGroup({
        pointerY,
        groupKey: session.sourceGroupKey,
        rects: session.rects,
        draggedIds: session.reorderUnitDraggedIds,
        draggingWorktreeId: session.draggingWorktreeId,
        grab: session.grab,
        anchor
      })
      worktreeDragSessionRef.current = {
        ...session,
        anchor: preview ? { beforeWorktreeId: preview.dropAnchorId, pointerY, scrollTop } : null
      }
      return preview
    },
    [computeWorktreeDropForGroup]
  )
  const computeWorktreeStatusDrop = useCallback(
    (args: {
      pointerY: number
      status: WorkspaceStatus
      draggedIds: readonly string[]
    }): WorktreeSidebarDropPreview | null => {
      const container = scrollRef.current
      if (!container) {
        return null
      }
      const groupKey = getWorkspaceStatusGroupKey(args.status)
      const session = worktreeDragSessionRef.current
      const scrollTop = container.scrollTop
      const heldAnchor = statusDropAnchorsRef.current.get(groupKey) ?? null
      const anchor = shouldReevaluateWorktreeSidebarDropAnchor({
        anchor: heldAnchor,
        pointerY: args.pointerY,
        scrollTop
      })
        ? null
        : heldAnchor
      const preview = computeWorktreeDropForGroup({
        pointerY: args.pointerY,
        groupKey,
        rects: getWorktreeSidebarDragRectsForGroup(container, groupKey),
        draggedIds: args.draggedIds,
        draggingWorktreeId: session?.draggingWorktreeId ?? null,
        grab: session?.grab ?? null,
        anchor
      })
      if (preview) {
        statusDropAnchorsRef.current.set(groupKey, {
          beforeWorktreeId: preview.dropAnchorId,
          pointerY: args.pointerY,
          scrollTop
        })
      } else {
        statusDropAnchorsRef.current.delete(groupKey)
      }
      return preview
    },
    [computeWorktreeDropForGroup]
  )
  const renderRows = useMemo(() => buildRenderableRows(rows), [rows])
  const sidebarRepoHeaderIdsByBucket = useMemo(
    () =>
      getSidebarOrderedRepoHeaderIdsByBucket(
        rows.filter((row): row is Row => row.type !== 'host-header')
      ),
    [rows]
  )
  const sidebarProjectGroupHeaderIdsByBucket = useMemo(
    () =>
      getSidebarOrderedProjectGroupHeaderIdsByBucket(
        rows.filter((row): row is Row => row.type !== 'host-header'),
        projectGroupByIdForHeaderDrag
      ),
    [projectGroupByIdForHeaderDrag, rows]
  )
  const repoHeaderIndexByRepoId = useMemo(() => {
    const map = new Map<string, number>()
    for (const repoIds of sidebarRepoHeaderIdsByBucket.values()) {
      repoIds.forEach((repoId, index) => {
        map.set(repoId, index)
      })
    }
    return map
  }, [sidebarRepoHeaderIdsByBucket])
  const repoHeaderBucketByRepoId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [bucketKey, repoIds] of sidebarRepoHeaderIdsByBucket) {
      for (const repoId of repoIds) {
        map.set(repoId, bucketKey)
      }
    }
    return map
  }, [sidebarRepoHeaderIdsByBucket])
  const projectGroupHeaderIndexByGroupId = useMemo(() => {
    const map = new Map<string, number>()
    for (const groupIds of sidebarProjectGroupHeaderIdsByBucket.values()) {
      groupIds.forEach((groupId, index) => {
        map.set(groupId, index)
      })
    }
    return map
  }, [sidebarProjectGroupHeaderIdsByBucket])
  const projectGroupHeaderBucketByGroupId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [bucketKey, groupIds] of sidebarProjectGroupHeaderIdsByBucket) {
      for (const groupId of groupIds) {
        map.set(groupId, bucketKey)
      }
    }
    return map
  }, [sidebarProjectGroupHeaderIdsByBucket])
  const commitProjectGroupOrder = useCallback(
    (repoId: string, projectGroupId: string | null, order: number) => {
      void moveProjectToGroup(repoId, projectGroupId, order)
    },
    [moveProjectToGroup]
  )
  const commitProjectGroupHeaderOrder = useCallback(
    (groupId: string, tabOrder: number) => {
      if (!Number.isFinite(tabOrder)) {
        return
      }
      const suppressUntil =
        window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
      suppressMeasurementAdjustmentUntilRef.current = suppressUntil
      directScrollInputUntilRef.current = suppressUntil
      void updateProjectGroup(groupId, { tabOrder })
    },
    [updateProjectGroup]
  )
  // Drag applies only in manual order; still construct the controller inert for stable hook order.
  const repoDrag = useRepoHeaderDrag({
    orderedRepoIds: allRepoIds,
    sidebarRepoHeaderIdsByBucket,
    repoById: repoMap,
    usesProjectGroupOrdering: hasProjectGroups,
    onCommitRepoOrder: commitRepoReorder,
    onCommitProjectGroupOrder: commitProjectGroupOrder,
    getScrollContainer: () => scrollRef.current
  })
  const projectGroupDrag = useProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket,
    projectGroupById: projectGroupByIdForHeaderDrag,
    onCommitProjectGroupTabOrder: commitProjectGroupHeaderOrder,
    getScrollContainer: () => scrollRef.current
  })
  const { primaryActiveWorktreeRow, getActiveSurfaceVariant, handleImmediateWorktreeRowActivate } =
    useWorktreeActiveRow({
      rows,
      activeWorktreeId,
      pinnedDisplayPolicy,
      onImmediateWorktreeActivate
    })
  const firstHeaderIndex = useMemo(
    () => renderRows.findIndex((row) => row.type === 'header' || row.type === 'host-header'),
    [renderRows]
  )
  const repoHeaderSectionEndByRepoId = useMemo(
    () =>
      getRepoHeaderSectionEndByRepoId({
        rows: renderRows,
        firstHeaderIndex,
        sidebarRepoHeaderIdsByBucket,
        repoHeaderBucketByRepoId
      }),
    [firstHeaderIndex, renderRows, repoHeaderBucketByRepoId, sidebarRepoHeaderIdsByBucket]
  )
  const projectGroupHeaderSectionEndByGroupId = useMemo(
    () =>
      getProjectGroupHeaderSectionEndByGroupId({
        rows: renderRows,
        firstHeaderIndex,
        sidebarProjectGroupHeaderIdsByBucket,
        projectGroupHeaderBucketByGroupId
      }),
    [
      firstHeaderIndex,
      projectGroupHeaderBucketByGroupId,
      renderRows,
      sidebarProjectGroupHeaderIdsByBucket
    ]
  )
  const stickyHeaderIndexes = useMemo(() => getStickyHeaderIndexes(renderRows), [renderRows])
  const activeStickyHeaderIndexRef = useRef<number | null>(null)
  const activeStickyHostIndexRef = useRef<number | null>(null)
  const stickyRangeStartIndexRef = useRef(0)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const getCachedFolderWorkspacePathStatus = useWorktreeFolderPathStatuses({
    allRepoIds,
    repoMap,
    projectGroups,
    folderWorkspaces,
    sshConnectionStates
  })
  const markScrollMovement = useCallback(() => {
    suppressMeasurementAdjustmentUntilRef.current =
      window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
  }, [])
  const markDirectScrollInput = useCallback(() => {
    const suppressUntil = window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
    suppressMeasurementAdjustmentUntilRef.current = suppressUntil
    directScrollInputUntilRef.current = suppressUntil
  }, [])
  const { showScrollToTop, scrollToTop } = useWorktreeListScrollToTop({
    scrollElement,
    onUserScrollIntent: markDirectScrollInput
  })
  const hasDirectScrollInput = useCallback(
    () => window.performance.now() < directScrollInputUntilRef.current,
    []
  )
  const markRevealScroll = useCallback((targetTop: number) => {
    pendingRevealScrollRef.current = createPendingRevealScroll(targetTop, window.performance.now())
  }, [])
  const isRevealScrollSettlingNow = useCallback(() => {
    const settling = isRevealScrollSettling({
      now: window.performance.now(),
      pending: pendingRevealScrollRef.current,
      scrollTop: scrollRef.current?.scrollTop ?? 0
    })
    if (!settling) {
      pendingRevealScrollRef.current = null
    }
    return settling
  }, [])
  // Why: programmatic scrolls keep measurement correction quiet, but only direct input blocks anchor-restore retries.
  // A reveal's smooth scroll is the exception: restoring the anchor mid-animation cancels it a few pixels in.
  const shouldSkipScrollAnchorRestore = useCallback(
    () =>
      window.performance.now() < directScrollInputUntilRef.current || isRevealScrollSettlingNow(),
    [isRevealScrollSettlingNow]
  )

  const { virtualizer, isCurrentVirtualRowElement } = useWorktreeListVirtualizer({
    renderRows,
    scrollRef,
    firstHeaderIndex,
    activeStickyHeaderIndexRef,
    stickyRangeStartIndexRef,
    stickyHeaderIndexes,
    scrollOffsetRef,
    suppressMeasurementAdjustmentUntilRef
  })

  useEffect(() => {
    const handleSuppress = () => {
      // Why: let an expanding agent row grow in place instead of TanStack compensating scrollTop.
      suppressMeasurementAdjustmentUntilRef.current =
        window.performance.now() + EXPANDING_CARD_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
    }
    window.addEventListener(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT, handleSuppress)
    return () => {
      window.removeEventListener(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT, handleSuppress)
    }
  }, [])

  useWorktreeListWorkspaceReveal({
    pendingRevealWorktree,
    agentSendTargetWorktreeId,
    groupBy,
    worktrees,
    folderWorkspaces,
    repoMap,
    prCache,
    worktreeLineageById,
    worktreeMap,
    renderRows,
    virtualizer,
    clearPendingRevealWorktreeId,
    toggleGroup,
    collapsedGroups,
    defaultHostId,
    workspaceStatuses,
    settings,
    pinnedDisplayPolicy,
    projectGrouping,
    projectGroups,
    pendingRevealRetryTick,
    setPendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    setRenamingWorktreeId,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scrollRef,
    pendingRevealRetryRef
  })
  useWorktreeListSidebarRowReveal({
    pendingRevealSidebarRow,
    repoMap,
    projectGroups,
    projectGrouping,
    collapsedGroups,
    groupBy,
    toggleGroup,
    renderRows,
    virtualizer,
    pendingRevealRetryTick,
    setPendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    clearPendingRevealSidebarRow,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scrollRef,
    pendingRowRevealRetryRef
  })

  const { lineageRowRekeys, measureVirtualRowElement } = useWorktreeVirtualRowMeasurement({
    renderRows,
    virtualizer,
    isCurrentVirtualRowElement
  })
  const totalSize = virtualizer.getTotalSize()
  const virtualItems = virtualizer.getVirtualItems()
  const activeStickyIndexes = getActiveStickyIndexesForScroll({
    rows: renderRows,
    rangeStartIndex: stickyRangeStartIndexRef.current,
    scrollOffset: virtualizer.scrollOffset ?? scrollOffsetRef.current,
    stickyHeaderIndexes,
    virtualItems
  })
  activeStickyHeaderIndexRef.current = activeStickyIndexes.groupIndex
  activeStickyHostIndexRef.current = activeStickyIndexes.hostIndex

  useVirtualizedScrollAnchor({
    anchorRef: scrollAnchorRef,
    getItemElementKey: getVirtualRowKey,
    getRowKey: getRenderRowKey,
    itemElementSelector: '[data-worktree-virtual-row]',
    rekeyedRowKeys: lineageRowRekeys,
    rows: renderRows,
    scrollElementRef: scrollRef,
    scrollOffsetRef,
    hasDirectScrollInput,
    shouldSkipRestore: shouldSkipScrollAnchorRestore,
    totalSize,
    virtualizer
  })

  const recordCurrentScrollAnchor = useCallback(() => {
    scrollRef.current?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
  }, [])
  const toggleGroupWithScrollAnchor = useCallback(
    (groupKey: string) => {
      recordCurrentScrollAnchor()
      toggleGroup(groupKey)
    },
    [recordCurrentScrollAnchor, toggleGroup]
  )
  // Why: memo'd WorktreeCard needs a per-group-key stable onLineageToggle
  // identity to bail out of re-renders; see worktree-lineage-toggle-handler-cache.
  const getLineageToggleHandler = useMemo(
    () => createLineageToggleHandlerCache(toggleGroupWithScrollAnchor),
    [toggleGroupWithScrollAnchor]
  )

  const { handleContainerKeyDown, handleScrollPointerDown, handleScroll } = useWorktreeListKeyboard(
    {
      rows,
      renderRows,
      activeWorktreeId,
      virtualizer,
      pinnedDisplayPolicy,
      activeModal,
      keybindings,
      scrollRef,
      markDirectScrollInput,
      markScrollMovement
    }
  )

  const cancelWorktreePointerAutoscroll = useCallback(() => {
    if (worktreePointerAutoscrollFrameIdRef.current !== null) {
      window.cancelAnimationFrame(worktreePointerAutoscrollFrameIdRef.current)
      worktreePointerAutoscrollFrameIdRef.current = null
    }
    worktreePointerAutoscrollLastFrameTimeRef.current = null
  }, [])

  const cancelWorktreeNativeAutoscroll = useCallback(() => {
    if (worktreeNativeAutoscrollFrameIdRef.current !== null) {
      window.cancelAnimationFrame(worktreeNativeAutoscrollFrameIdRef.current)
      worktreeNativeAutoscrollFrameIdRef.current = null
    }
    worktreeNativeAutoscrollLastFrameTimeRef.current = null
    worktreeNativeLatestPointRef.current = null
  }, [])

  const cleanupWorktreePointerDrag = useCallback(() => {
    const drag = worktreePointerDragRef.current
    cancelWorktreePointerAutoscroll()
    setNativeLineageDropTargetId(null)
    if (!drag) {
      return
    }
    if (drag.frameId !== null) {
      window.cancelAnimationFrame(drag.frameId)
    }
    drag.preview?.remove()
    worktreePointerDragRef.current = null
    setSidebarPointerDragDocumentStyles(false)
    setDragOverStatus(null)
    setPinDragOver(false)
    clearWorkspaceKanbanSidebarDropTargetVisual()
    onWorkspaceBoardDragPreviewCancel()
  }, [cancelWorktreePointerAutoscroll, onWorkspaceBoardDragPreviewCancel])

  const clearWorktreeDrag = useCallback(() => {
    cleanupWorktreePointerDrag()
    cancelWorktreeNativeAutoscroll()
    worktreeDragSessionRef.current = null
    statusDropAnchorsRef.current.clear()
    setWorktreeDragState(WORKTREE_ROW_DRAG_INITIAL_STATE)
  }, [cancelWorktreeNativeAutoscroll, cleanupWorktreePointerDrag])

  const setScrollRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null && scrollRef.current !== null) {
        // Why: drag previews, autoscroll frames, and reveal snapshots are tied to the scroll root; clear them before it unmounts.
        cancelPendingRevealFrames()
        clearRevealHighlight()
        clearWorktreeDrag()
      }
      scrollRef.current = node
      setScrollElement(node)
    },
    [cancelPendingRevealFrames, clearRevealHighlight, clearWorktreeDrag]
  )

  const getEligibleLineageDropTarget = useCallback(
    (
      target: WorktreeSidebarStatusDropTarget & { lineageParentId: string | null },
      draggedIds: readonly string[]
    ): WorktreeSidebarStatusDropTarget & { lineageParentId: string | null } => {
      const parentId = target.lineageParentId
      if (!parentId) {
        return target
      }
      const canAssignAll = draggedIds.every((draggedId) => {
        const child = worktreeMap.get(draggedId)
        if (!child) {
          return false
        }
        const candidateParent = worktreeMap.get(parentId)
        return Boolean(
          candidateParent &&
          isEligibleWorktreeParent({
            child,
            candidateParent,
            lineageById: worktreeLineageById,
            worktreeMap,
            repoMap,
            cyclicLineageIds
          })
        )
      })
      return canAssignAll ? target : { ...target, lineageParentId: null }
    },
    [cyclicLineageIds, repoMap, worktreeLineageById, worktreeMap]
  )

  const commitWorktreeLineageParentDrop = useCallback(
    (draggedIds: readonly string[], parentId: string): boolean => {
      const target = getEligibleLineageDropTarget(
        { status: null, isPinDrop: false, lineageParentId: parentId },
        draggedIds
      )
      if (!target.lineageParentId) {
        return false
      }
      void Promise.all(
        draggedIds.map((id) => assignWorktreeParent(id, { parentWorktreeId: parentId }))
      ).catch((err) => {
        console.error('Failed to nest workspace:', err)
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.failedNestWorkspace',
            'Failed to nest workspace'
          )
        )
      })
      return true
    },
    [assignWorktreeParent, getEligibleLineageDropTarget]
  )

  const clearReorderedWorktreeParents = useCallback(
    (args: { draggedIds: readonly string[]; sourceGroupKey: string }) => {
      const sourceGroup = worktreeDragGroups.find((group) => group.key === args.sourceGroupKey)
      if (!sourceGroup) {
        return
      }
      const ids = getReorderedWorktreeIdsToUnnest({
        draggedIds: args.draggedIds,
        sourceGroupIds: sourceGroup.worktreeIds,
        lineageById: worktreeLineageById,
        worktreeMap,
        cyclicLineageIds
      })
      if (ids.length === 0) {
        return
      }
      // Why: dropping a nested card on a reorder line is the un-nest escape hatch; clear only the dragged children.
      void Promise.all(ids.map((id) => updateWorktreeLineage(id, { noParent: true }))).catch(
        (err) => {
          console.error('Failed to unnest workspace:', err)
          toast.error(
            translate(
              'auto.components.sidebar.WorktreeList.failedUnnestWorkspace',
              'Failed to unnest workspace'
            )
          )
        }
      )
    },
    [cyclicLineageIds, updateWorktreeLineage, worktreeDragGroups, worktreeLineageById, worktreeMap]
  )

  const flushWorktreePointerDrag = useWorktreePointerDragFlush({
    worktreePointerDragRef,
    scrollRef,
    clearWorktreeDrag,
    refreshWorktreeDragSession,
    workspaceBoardOpen,
    onWorkspaceBoardDragPreviewStart,
    onWorkspaceBoardDragPreviewCommit,
    shouldShowWorkspaceBoardDropIndicator,
    getEligibleLineageDropTarget,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    setDragOverStatus,
    setPinDragOver,
    setWorktreeDragState,
    workspaceStatuses
  })

  const {
    scheduleWorktreePointerDragFrame,
    beginWorktreePointerDrag,
    handleWorktreeRowPointerDown,
    handleWorktreeRowClickCapture
  } = useWorktreePointerDragController({
    flushWorktreePointerDrag,
    worktreePointerDragRef,
    worktreePointerAutoscrollFrameIdRef,
    worktreePointerAutoscrollLastFrameTimeRef,
    worktreeDragSessionRef,
    scrollRef,
    suppressWorktreeClickUntilRef,
    cancelWorktreePointerAutoscroll,
    clearWorktreeDrag,
    markScrollMovement,
    refreshWorktreeDragSession,
    setWorktreeDragState,
    groupKeyByRowKey,
    workspaceBoardOpen,
    onWorkspaceBoardDragPreviewStart,
    noopWorkspaceBoardDragPreviewCallback: NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK,
    selectedWorktreeIds,
    selectedWorktrees,
    getReorderDraggedIds,
    getReorderUnitDraggedIds
  })

  useWorktreePointerDragCommit({
    worktreePointerDragRef,
    scrollRef,
    beginWorktreePointerDrag,
    scheduleWorktreePointerDragFrame,
    refreshWorktreeDragSession,
    clearWorktreeDrag,
    onWorkspaceBoardDragPreviewCommit,
    onPinWorktrees,
    onDropWorktreesOnWorkspaceBoard,
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatusAtIndex,
    onMoveWorktreesToStatus,
    computeWorktreeDrop,
    onReorderWorktrees,
    worktreeDragGroups,
    worktreeDragUnitGroups,
    clearReorderedWorktreeParents,
    workspaceStatuses
  })

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (window.performance.now() >= suppressWorktreeClickUntilRef.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }

    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [])
  const { startWorktreeNativeAutoscroll, handleWorktreeCardDragStart } = useWorktreeNativeDragStart(
    {
      worktreeNativeAutoscrollFrameIdRef,
      worktreeNativeAutoscrollLastFrameTimeRef,
      worktreeNativeLatestPointRef,
      scrollRef,
      worktreeDragSessionRef,
      cancelWorktreeNativeAutoscroll,
      markScrollMovement,
      refreshWorktreeDragSession,
      clearWorktreeDrag,
      computeWorktreeDrop,
      computeWorktreeStatusDrop,
      setWorktreeDragState,
      worktreeDragGroups,
      getReorderDraggedIds,
      getReorderUnitDraggedIds
    }
  )

  const { handleWorktreeDragOver, handleWorktreeDrop } = useWorktreeNativeDragHandlers({
    worktreeDragSessionRef,
    worktreeNativeLatestPointRef,
    scrollRef,
    startWorktreeNativeAutoscroll,
    refreshWorktreeDragSession,
    clearWorktreeDrag,
    getEligibleLineageDropTarget,
    setNativeLineageDropTargetId,
    setWorktreeDragState,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    commitWorktreeLineageParentDrop,
    onMoveWorktreesToStatusAtIndex,
    worktreeDragGroups,
    onReorderWorktrees,
    worktreeDragUnitGroups,
    clearReorderedWorktreeParents
  })

  useWorktreeVisibleReviewRefresh({
    lastVisibleRefreshKeyRef,
    currentWorktreeId,
    worktreeMap,
    rightSidebarShowsPR,
    groupBy,
    newCardStyle,
    cardProps,
    scrollRef,
    virtualItems,
    renderRows,
    sshConnectedGeneration,
    prVisibleRefreshGeneration,
    reportVisibleGitHubPRRefreshCandidates,
    documentVisibilityRevision
  })

  const activeDescendantId = getActiveDescendantOptionId({
    activeWorktreeId,
    primaryActiveRowKey:
      primaryActiveWorktreeRow?.worktreeId === activeWorktreeId
        ? primaryActiveWorktreeRow.rowKey
        : undefined,
    pinnedDisplayPolicy,
    renderRows,
    virtualItems
  })

  const {
    hasWorkspaceDropTargets,
    handleWorkspaceStatusDragOver,
    handleWorkspaceStatusDragLeave,
    handleWorkspacePinDragOver,
    handleWorkspacePinDragLeave,
    handleWorkspaceStatusDragFinish,
    handleWorkspaceStatusDrop
  } = useWorktreeStatusDropHandlers({
    groupBy,
    rows,
    setDragOverStatus,
    setPinDragOver,
    worktreeDragSessionRef,
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatusAtIndex,
    worktreeDragGroups,
    clearWorktreeDrag,
    onMoveWorktreesToStatus,
    getReorderDraggedIds
  })

  useWorktreeNativeDropEffects({
    worktreeDragSessionRef,
    scrollRef,
    refreshWorktreeDragSession,
    clearWorktreeDrag,
    computeWorktreeDrop,
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatusAtIndex,
    worktreeDragGroups,
    onReorderWorktrees,
    worktreeDragUnitGroups,
    clearReorderedWorktreeParents
  })

  // Why: expand here (not the shared hook, used by the flat board) so a dropped parent carries its lineage children (#9083).
  const moveWorktreesToStatusForDocumentDrop = useCallback(
    (ids: readonly string[], status: WorkspaceStatus) =>
      onMoveWorktreesToStatus(getReorderDraggedIds(ids), status),
    [getReorderDraggedIds, onMoveWorktreesToStatus]
  )

  useWorkspaceStatusDocumentDrop(
    scrollRef,
    onMoveWorktreeToStatus,
    onPinWorktree,
    handleWorkspaceStatusDragFinish,
    hasWorkspaceDropTargets,
    {
      onMoveWorktreesToStatus: moveWorktreesToStatusForDocumentDrop,
      onPinWorktrees
    }
  )

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
        aria-activedescendant={activeDescendantId}
        onKeyDown={handleContainerKeyDown}
        // Why: trackpad momentum fires sparse scroll events after the input stream quiets; suppress correction until the viewport stops.
        onScroll={handleScroll}
        onPointerDown={handleScrollPointerDown}
        onTouchMove={markDirectScrollInput}
        onWheel={markDirectScrollInput}
        onDragOver={handleWorktreeDragOver}
        onDrop={handleWorktreeDrop}
        className="worktree-sidebar-scrollbar h-full overflow-y-auto overflow-x-hidden pl-1 scrollbar-sleek outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset pt-px"
        style={WORKTREE_SIDEBAR_SCROLL_STYLE}
      >
        <div
          role="presentation"
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {canReorderRepoHeaders &&
          repoDrag.state.draggingRepoId !== null &&
          repoDrag.state.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator y={repoDrag.state.dropIndicatorY} />
          ) : null}
          {canReorderProjectGroupHeaders &&
          projectGroupDrag.state.draggingGroupId !== null &&
          projectGroupDrag.state.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator y={projectGroupDrag.state.dropIndicatorY} />
          ) : null}
          {hostDrag.state.draggingHostId !== null && hostDrag.state.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator y={hostDrag.state.dropIndicatorY} className="z-40" />
          ) : null}
          {worktreeDragState.draggingWorktreeId !== null &&
          worktreeDragState.dropIndicatorY !== null ? (
            <WorktreeSidebarDropIndicator y={worktreeDragState.dropIndicatorY} />
          ) : null}
          {virtualItems.map((vItem) => {
            const row = renderRows[vItem.index]
            if (!row) {
              return null
            }

            if (row.type === 'host-header') {
              // Why: the host card is the outer tier; it pins above group headers (z-30 vs z-20) and stays put as they hand off.
              const isActiveStickyHost = activeStickyHostIndexRef.current === vItem.index
              const hasHeaderTopSpacing = shouldUseHeaderTopSpacing({
                rows: renderRows,
                index: vItem.index,
                firstHeaderIndex
              })
              return (
                <div
                  key={vItem.key}
                  role="presentation"
                  data-worktree-virtual-row
                  data-worktree-virtual-row-key={String(vItem.key)}
                  data-worktree-sticky-header=""
                  data-worktree-sticky-header-active={isActiveStickyHost ? '' : undefined}
                  data-index={vItem.index}
                  ref={measureVirtualRowElement}
                  className={cn(
                    'left-0 right-0',
                    hasHeaderTopSpacing && !isActiveStickyHost && 'pt-1',
                    isActiveStickyHost
                      ? 'sticky -top-px z-30 bg-worktree-sidebar'
                      : 'absolute top-0'
                  )}
                  style={
                    isActiveStickyHost
                      ? undefined
                      : { transform: getVirtualRowTransform(vItem.start) }
                  }
                >
                  <WorktreeListHostSectionHeader
                    row={row}
                    onToggle={() => toggleGroupWithScrollAnchor(row.key)}
                    onDragPointerDown={
                      orderedHostIds.length > 1
                        ? (e) => hostDrag.onHandlePointerDown(e, row.hostId)
                        : undefined
                    }
                    dragging={hostDrag.state.draggingHostId === row.hostId}
                  />
                </div>
              )
            }

            if (row.type === 'header') {
              const model = getWorktreeListSectionHeaderModel({
                row,
                index: vItem.index,
                renderRows,
                firstHeaderIndex,
                activeStickyHeaderIndex: activeStickyHeaderIndexRef.current,
                activeStickyHostIndex: activeStickyHostIndexRef.current,
                groupBy,
                canReorderRepoHeaders,
                canReorderProjectGroupHeaders,
                repoHeaderIndexByRepoId,
                repoHeaderBucketByRepoId,
                repoHeaderSectionEndByRepoId,
                sidebarRepoHeaderIdsByBucket,
                projectGroupHeaderIndexByGroupId,
                projectGroupHeaderBucketByGroupId,
                projectGroupHeaderSectionEndByGroupId,
                sidebarProjectGroupHeaderIdsByBucket,
                draggingRepoId: repoDrag.state.draggingRepoId,
                draggingProjectGroupId: projectGroupDrag.state.draggingGroupId,
                workspaceStatuses,
                sshConnectionStates,
                getCachedFolderWorkspacePathStatus,
                collapsedGroups
              })
              return (
                <WorktreeListSectionHeader
                  key={vItem.key}
                  row={row}
                  virtualItem={vItem}
                  model={model}
                  measureVirtualRowElement={measureVirtualRowElement}
                  highlightedRevealRowKey={highlightedRevealRowKey}
                  dragOverStatus={dragOverStatus}
                  pinDragOver={pinDragOver}
                  toggleGroupWithScrollAnchor={toggleGroupWithScrollAnchor}
                  handleWorkspacePinDragOver={handleWorkspacePinDragOver}
                  handleWorkspacePinDragLeave={handleWorkspacePinDragLeave}
                  handleWorkspaceStatusDragOver={handleWorkspaceStatusDragOver}
                  handleWorkspaceStatusDragLeave={handleWorkspaceStatusDragLeave}
                  handleWorkspaceStatusDrop={handleWorkspaceStatusDrop}
                  handleRepoHeaderPointerDown={repoDrag.onHandlePointerDown}
                  handleProjectGroupHeaderPointerDown={projectGroupDrag.onHandlePointerDown}
                  projectGroups={projectGroups}
                  handleCreateForRepo={handleCreateForRepo}
                  handleOpenRepoSettings={handleOpenRepoSettings}
                  handleOpenWorktreeVisibility={handleOpenWorktreeVisibility}
                  handleRemoveProject={handleRemoveProject}
                  handleCreateGroupFromRepo={handleCreateGroupFromRepo}
                  handleMoveProjectToGroup={handleMoveProjectToGroup}
                  handleRemoveProjectFromGroup={handleRemoveProjectFromGroup}
                  handleRenameProjectGroup={handleRenameProjectGroup}
                  handleDeleteProjectGroup={handleDeleteProjectGroup}
                  handleCreateFolderWorkspace={handleCreateFolderWorkspace}
                />
              )
            }
            const renderWorktreeRow = (
              itemRow: WorktreeItemRow,
              nested: boolean,
              lineageChildren?: React.ReactNode,
              forceActiveSurface = false
            ) => (
              <WorktreeListWorktreeRow
                key={itemRow.rowKey}
                itemRow={itemRow}
                nested={nested}
                lineageChildren={lineageChildren}
                forceActiveSurface={forceActiveSurface}
                settings={settings}
                groupBy={groupBy}
                folderBackedProjectGroupIds={folderBackedProjectGroupIds}
                groupKeyByRowKey={groupKeyByRowKey}
                groupIndexByRowKey={groupIndexByRowKey}
                agentSendTargetWorktreeId={agentSendTargetWorktreeId}
                worktreeDragState={worktreeDragState}
                worktreePointerDragRef={worktreePointerDragRef}
                nativeLineageDropTargetId={nativeLineageDropTargetId}
                activeWorktreeId={activeWorktreeId}
                currentWorktreeId={currentWorktreeId}
                selectedWorktreeIds={selectedWorktreeIds}
                selectedWorktrees={selectedWorktrees}
                highlightedRevealRowKey={highlightedRevealRowKey}
                getActiveSurfaceVariant={getActiveSurfaceVariant}
                handleWorktreeRowClickCapture={handleWorktreeRowClickCapture}
                handleWorktreeRowPointerDown={handleWorktreeRowPointerDown}
                handleImmediateWorktreeRowActivate={handleImmediateWorktreeRowActivate}
                onSelectionGesture={onSelectionGesture}
                onContextMenuSelect={onContextMenuSelect}
                handleWorktreeCardDragStart={handleWorktreeCardDragStart}
                clearWorktreeDrag={clearWorktreeDrag}
                getLineageToggleHandler={getLineageToggleHandler}
              />
            )
            const renderLineageDescendants = (
              parent: WorktreeItemRow,
              descendants: readonly WorktreeItemRow[]
            ): React.ReactNode | undefined => {
              const childNodes: React.ReactNode[] = []
              let cursor = 0
              while (cursor < descendants.length) {
                const child = descendants[cursor]
                if (!child || child.depth !== parent.depth + 1) {
                  cursor++
                  continue
                }

                let nextSiblingIndex = cursor + 1
                while (
                  nextSiblingIndex < descendants.length &&
                  descendants[nextSiblingIndex]!.depth > child.depth
                ) {
                  nextSiblingIndex++
                }

                const childLineageChildren = renderLineageDescendants(
                  child,
                  descendants.slice(cursor + 1, nextSiblingIndex)
                )
                childNodes.push(renderWorktreeRow(child, true, childLineageChildren))
                cursor = nextSiblingIndex
              }
              return childNodes.length > 0 ? childNodes : undefined
            }

            if (row.type === 'lineage-group') {
              const [parent, ...children] = row.rows
              const childIsActive = children.some((child) => child.worktree.id === activeWorktreeId)
              const parentPreviewOffset = parent
                ? (worktreeDragState.previewOffsetsByWorktreeId.get(parent.worktree.id) ?? 0)
                : 0
              return (
                <div
                  key={vItem.key}
                  role="presentation"
                  data-worktree-virtual-row
                  data-worktree-virtual-row-key={String(vItem.key)}
                  data-worktree-virtual-row-start={vItem.start}
                  data-index={vItem.index}
                  ref={measureVirtualRowElement}
                  className={cn(
                    'absolute left-0 right-0 top-0',
                    worktreeDragState.draggingWorktreeId !== null &&
                      'transition-transform duration-150 ease-out will-change-transform'
                  )}
                  style={{
                    transform: getWorktreeVirtualRowTransform(vItem.start, parentPreviewOffset)
                  }}
                >
                  <div className="overflow-visible">
                    {parent
                      ? renderWorktreeRow(
                          parent,
                          false,
                          renderLineageDescendants(parent, children),
                          childIsActive
                        )
                      : null}
                  </div>
                </div>
              )
            }

            if (
              row.type === 'imported-worktrees-card' ||
              row.type === 'new-external-worktrees-inbox' ||
              row.type === 'pending-creation'
            ) {
              return (
                <WorktreeListAuxiliaryRow
                  key={vItem.key}
                  row={row}
                  virtualItem={vItem}
                  measureVirtualRowElement={measureVirtualRowElement}
                  importedWorktreeCardActionState={importedWorktreeCardActionState}
                  newExternalWorktreeInboxActionState={newExternalWorktreeInboxActionState}
                  handleShowImportedWorktrees={handleShowImportedWorktrees}
                  handleKeepImportedWorktreesHidden={handleKeepImportedWorktreesHidden}
                  handleOpenWorktreeVisibility={handleOpenWorktreeVisibility}
                  handleOpenSuppressExternalWorktreeInbox={handleOpenSuppressExternalWorktreeInbox}
                />
              )
            }
            if (row.type === 'folder-workspace') {
              return (
                <WorktreeListFolderWorkspaceRow
                  key={vItem.key}
                  row={row}
                  virtualItem={vItem}
                  measureVirtualRowElement={measureVirtualRowElement}
                  getCachedFolderWorkspacePathStatus={getCachedFolderWorkspacePathStatus}
                  workspaceLineageByChildKey={workspaceLineageByChildKey}
                  worktreeLineageById={worktreeLineageById}
                  worktreeMap={worktreeMap}
                  repoMap={repoMap}
                  hostedReviewCache={hostedReviewCache}
                  prCache={prCache}
                  settings={settings}
                  groupBy={groupBy}
                  newCardStyle={newCardStyle}
                  selectedWorktreeIds={selectedWorktreeIds}
                  activeWorktreeId={activeWorktreeId}
                  currentWorktreeId={currentWorktreeId}
                  handleWorktreeRowClickCapture={handleWorktreeRowClickCapture}
                  handleWorktreeRowPointerDown={handleWorktreeRowPointerDown}
                  handleImmediateWorktreeRowActivate={handleImmediateWorktreeRowActivate}
                  onSelectionGesture={onSelectionGesture}
                  onContextMenuSelect={onContextMenuSelect}
                />
              )
            }
            const itemWorkspaceStatus =
              groupBy === 'workspace-status'
                ? getWorkspaceStatus(row.worktree, workspaceStatuses)
                : null
            const itemPreviewOffset =
              worktreeDragState.previewOffsetsByWorktreeId.get(row.worktree.id) ?? 0

            return (
              <div
                key={vItem.key}
                role="presentation"
                data-worktree-virtual-row
                data-worktree-virtual-row-key={String(vItem.key)}
                data-worktree-virtual-row-start={vItem.start}
                data-index={vItem.index}
                ref={measureVirtualRowElement}
                data-workspace-status-drop-target={itemWorkspaceStatus ? '' : undefined}
                data-workspace-status={itemWorkspaceStatus ?? undefined}
                className={cn(
                  'absolute left-0 right-0 top-0',
                  worktreeDragState.draggingWorktreeId !== null &&
                    'transition-transform duration-150 ease-out will-change-transform'
                )}
                style={{
                  transform: getWorktreeVirtualRowTransform(vItem.start, itemPreviewOffset)
                }}
                onDragOver={
                  itemWorkspaceStatus
                    ? (event) => handleWorkspaceStatusDragOver(event, itemWorkspaceStatus)
                    : undefined
                }
                onDragLeave={itemWorkspaceStatus ? handleWorkspaceStatusDragLeave : undefined}
                onDrop={
                  itemWorkspaceStatus
                    ? (event) => handleWorkspaceStatusDrop(event, itemWorkspaceStatus)
                    : undefined
                }
              >
                {renderWorktreeRow(row, false)}
              </div>
            )
          })}
        </div>
      </div>
      {showScrollToTop ? <WorktreeListScrollToTopButton onClick={scrollToTop} /> : null}
    </div>
  )
})

type WorktreeListProps = {
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  workspaceBoardOpen?: boolean
  onWorkspaceBoardDragPreviewStart?: () => void
  onWorkspaceBoardDragPreviewCommit?: () => void
  onWorkspaceBoardDragPreviewCancel?: () => void
}

const WorktreeList = React.memo(function WorktreeList({
  scrollOffsetRef,
  scrollAnchorRef,
  workspaceBoardOpen = false,
  onWorkspaceBoardDragPreviewStart = NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK,
  onWorkspaceBoardDragPreviewCommit = NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK,
  onWorkspaceBoardDragPreviewCancel = NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK
}: WorktreeListProps) {
  // ── Granular selectors (each is a primitive or shallow-stable ref) ──
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const currentSidebarWorktreeId = useMemo(
    () => getActiveSidebarWorkspaceId(activeWorkspaceKey, activeWorktreeId),
    [activeWorkspaceKey, activeWorktreeId]
  )
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const workspaceHostOrder = useAppStore((s) => s.workspaceHostOrder)
  const setWorkspaceHostOrder = useAppStore((s) => s.setWorkspaceHostOrder)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const agentStatusEpoch = useAppStore((s) => (!showSleepingWorkspaces ? s.agentStatusEpoch : 0))
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const updateWorktreesMeta = useAppStore((s) => s.updateWorktreesMeta)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
  const pendingRevealWorktree = useAppStore((s) => s.pendingRevealWorktree)
  const pendingRevealSidebarRow = useAppStore((s) => s.pendingRevealSidebarRow)
  const revealWorktreeInSidebar = useAppStore((s) => s.revealWorktreeInSidebar)
  const revealSidebarRow = useAppStore((s) => s.revealSidebarRow)
  const setWorktreesPinnedAndReveal = useAppStore((s) => s.setWorktreesPinnedAndReveal)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)
  const clearPendingRevealSidebarRow = useAppStore((s) => s.clearPendingRevealSidebarRow)
  const agentSendPopoverTargetMode = useAppStore((s) => s.agentSendPopoverTargetMode)
  // Why: eligibility only matters while the picker is open; when closed, don't subscribe to wake-time layout churn.
  const agentTargetStatusByPaneKey = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.agentStatusByPaneKey : EMPTY_AGENT_STATUS_BY_PANE_KEY
  )
  const agentTargetStatusEpoch = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.agentStatusEpoch : 0
  )
  const agentTargetTabsByWorktree = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.tabsByWorktree : EMPTY_TABS_BY_WORKTREE
  )
  const agentTargetTerminalLayoutsByTabId = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.terminalLayoutsByTabId : EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID
  )
  const agentTargetPtyIdsByTabId = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.ptyIdsByTabId : EMPTY_PTY_IDS_BY_TAB_ID
  )
  const agentTargetRuntimePaneTitlesByTabId = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.runtimePaneTitlesByTabId : EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID
  )
  const agentSendTargetWorktreeId = useMemo(() => {
    void agentTargetStatusEpoch
    if (!agentSendPopoverTargetMode) {
      return null
    }
    const targets = deriveRunningAgentSendTargets(
      {
        agentStatusByPaneKey: agentTargetStatusByPaneKey,
        tabsByWorktree: agentTargetTabsByWorktree,
        terminalLayoutsByTabId: agentTargetTerminalLayoutsByTabId,
        ptyIdsByTabId: agentTargetPtyIdsByTabId,
        runtimePaneTitlesByTabId: agentTargetRuntimePaneTitlesByTabId
      },
      agentSendPopoverTargetMode.worktreeId
    )
    return targets.some((target) => target.status === 'eligible')
      ? agentSendPopoverTargetMode.worktreeId
      : null
  }, [
    // Why: eligibility can flip when the stale-boundary scheduler bumps this epoch without replacing the status map.
    agentTargetStatusEpoch,
    agentSendPopoverTargetMode,
    agentTargetStatusByPaneKey,
    agentTargetTabsByWorktree,
    agentTargetTerminalLayoutsByTabId,
    agentTargetPtyIdsByTabId,
    agentTargetRuntimePaneTitlesByTabId
  ])

  // Read tabsByWorktree when needed for filtering or sorting
  const needsActivityMaps = !showSleepingWorkspaces || sortBy === 'smart'
  const tabsByWorktree = useAppStore((s) =>
    needsActivityMaps ? getVisibleWorktreeTerminalActivityTabs(s.tabsByWorktree) : null
  )
  const ptyIdsByTabId = useAppStore((s) => (needsActivityMaps ? s.ptyIdsByTabId : null))
  const browserTabsByWorktree = useAppStore((s) =>
    !showSleepingWorkspaces ? getVisibleWorktreeBrowserActivityTabs(s.browserTabsByWorktree) : null
  )

  const cardProps = useAppStore((s) => s.worktreeCardProperties)

  const { prCache, hostedReviewCache } = useAppStore(
    useShallow((s) => selectWorktreeListReviewCacheInputs(s, groupBy, cardProps))
  )
  const settings = useAppStore((s) => s.settings)
  const pinnedDisplayPolicy = getPinnedWorktreeDisplayPolicy(settings)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const pairedDeviceIdsByEnvironment = useMemo(
    () =>
      hideWorkspacesFromOtherDevices
        ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
        : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    [hideWorkspacesFromOtherDevices, runtimeEnvironments, runtimeStatusByEnvironmentId]
  )

  const sortEpoch = useAppStore((s) => s.sortEpoch)
  const sortedIds = useWorktreeListSmartOrder({
    allWorktrees,
    repoMap,
    sortBy,
    sortEpoch
  })
  const recomputedVisibleWorktrees = useMemo(() => {
    void agentStatusEpoch
    const ids = computeVisibleWorktreeIds(worktreesByRepo, sortedIds, {
      filterRepoIds,
      showSleepingWorkspaces,
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      // Why snapshot on agentStatusEpoch: update membership immediately without repainting on every hook ping.
      worktreeIdsWithLiveAgent: showSleepingWorkspaces
        ? EMPTY_WORKTREE_ID_SET
        : getWorktreeIdsWithLiveAgent(
            useAppStore.getState().agentStatusByPaneKey,
            tabsByWorktree,
            Date.now()
          ),
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      pairedDeviceIdsByEnvironment,
      alwaysShowDefaultBranchWorkspace,
      repoMap,
      workspaceHostScope,
      visibleWorkspaceHostIds,
      defaultHostId: getSettingsFocusedExecutionHostId(settings),
      worktreeLineageById,
      forcedVisibleWorktreeIds: agentSendTargetWorktreeId ? [agentSendTargetWorktreeId] : undefined
    })
    return ids.map((id) => worktreeMap.get(id)).filter((w): w is Worktree => w != null)
  }, [
    agentSendTargetWorktreeId,
    agentStatusEpoch,
    filterRepoIds,
    showSleepingWorkspaces,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace,
    workspaceHostScope,
    visibleWorkspaceHostIds,
    settings,
    repoMap,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    sortedIds,
    worktreeMap,
    worktreeLineageById,
    worktreesByRepo,
    pairedDeviceIdsByEnvironment
  ])
  // Why: agentStatusEpoch bumps recompute this memo even when membership and
  // order are unchanged; keeping the previous identity stops the whole
  // rows/sectionRows/renderedWorktrees chain from churning per epoch.
  const visibleWorktrees = useReusedArrayIdentity(recomputedVisibleWorktrees)

  const worktrees = visibleWorktrees
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const toggleGroup = useAppStore((s) => s.toggleCollapsedGroup)

  // Why: manual header order is bound to state.repos; Recent/Smart derive order from the sorted worktree stream.
  const repos = useAppStore((s) => s.repos)
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const projectGrouping = useMemo(
    () => ({
      projects: projectHostSetupProjection.projects,
      projectHostSetups: projectHostSetupProjection.setups
    }),
    [projectHostSetupProjection]
  )
  const projectGroups = useAppStore((s) => s.projectGroups ?? EMPTY_PROJECT_GROUPS)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const effectiveCollapsedGroups = useMemo(() => {
    if (!agentSendTargetWorktreeId) {
      return collapsedGroups
    }
    const targetWorktree = worktreeMap.get(agentSendTargetWorktreeId)
    if (!targetWorktree) {
      return collapsedGroups
    }
    const next = new Set(collapsedGroups)
    if (targetWorktree.isPinned) {
      next.delete(PINNED_GROUP_KEY)
    } else {
      for (const groupKey of getGroupKeysForWorktree(
        groupBy,
        targetWorktree,
        repoMap,
        prCache,
        workspaceStatuses,
        settings,
        projectGroups,
        projectGrouping
      )) {
        next.delete(groupKey)
      }
    }

    for (const parent of getWorktreeLineageAncestors(
      targetWorktree,
      worktreeLineageById,
      worktreeMap
    )) {
      next.delete(getLineageGroupKey(parent.id))
    }
    return next
  }, [
    agentSendTargetWorktreeId,
    collapsedGroups,
    groupBy,
    prCache,
    projectGroups,
    projectGrouping,
    repoMap,
    settings,
    workspaceStatuses,
    worktreeLineageById,
    worktreeMap
  ])
  const defaultHostId = getSettingsFocusedExecutionHostId(settings)
  const visibleHostIdSet = useMemo(
    () => getVisibleSidebarHostIdSet(visibleWorkspaceHostIds, workspaceHostScope),
    [visibleWorkspaceHostIds, workspaceHostScope]
  )
  const visibleReposForRows = useMemo(() => {
    if (!visibleHostIdSet) {
      return repos
    }
    return repos.filter((repo) => {
      const hostId =
        repo.connectionId || repo.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
      return visibleHostIdSet.has(hostId)
    })
  }, [defaultHostId, repos, visibleHostIdSet])
  const visibleProjectGroupsForRows = useMemo(
    () => filterProjectGroupsForVisibleHosts(projectGroups, visibleHostIdSet, defaultHostId),
    [defaultHostId, projectGroups, visibleHostIdSet]
  )
  const visibleFolderWorkspacesForRows = useMemo(() => {
    const hostVisibleWorkspaces = filterFolderWorkspacesForVisibleHosts(
      folderWorkspaces,
      projectGroups,
      visibleHostIdSet,
      defaultHostId
    )
    if (!hideWorkspacesFromOtherDevices) {
      return hostVisibleWorkspaces
    }
    return filterFolderWorkspacesFromOtherDevices(
      hostVisibleWorkspaces,
      pairedDeviceIdsByEnvironment
    )
  }, [
    defaultHostId,
    folderWorkspaces,
    hideWorkspacesFromOtherDevices,
    pairedDeviceIdsByEnvironment,
    projectGroups,
    visibleHostIdSet
  ])
  const repoOrder = useMemo(() => {
    return getLogicalRepoOrderRankById(repos.map((repo) => repo.id))
  }, [repos])
  const [importedWorktreeCardActionState, setImportedWorktreeCardActionState] = useState<
    Map<string, ImportedWorktreeCardActionState>
  >(new Map())
  const [newExternalWorktreeInboxActionState, setNewExternalWorktreeInboxActionState] = useState<
    Map<string, NewExternalWorktreesInboxActionState>
  >(new Map())
  const [suppressExternalWorktreeInboxRepoId, setSuppressExternalWorktreeInboxRepoId] = useState<
    string | null
  >(null)
  const importedWorktreesByRepo = useMemo(() => {
    const forceVisibleRepoIds = new Set(
      [...importedWorktreeCardActionState.entries()]
        .filter(([, state]) => state.forceVisible)
        .map(([repoId]) => repoId)
    )
    return buildImportedWorktreesCardCandidates({
      repos: visibleReposForRows,
      detectedWorktreesByRepo,
      filterRepoIds,
      forceVisibleRepoIds
    })
  }, [detectedWorktreesByRepo, filterRepoIds, importedWorktreeCardActionState, visibleReposForRows])
  const newExternalWorktreesInboxByRepo = useMemo(
    () =>
      buildNewExternalWorktreesInboxCandidates({
        repos: visibleReposForRows,
        detectedWorktreesByRepo,
        filterRepoIds
      }),
    [detectedWorktreesByRepo, filterRepoIds, visibleReposForRows]
  )
  const placeholderRepoIds = useMemo(() => {
    return getEmptyProjectPlaceholderRepoIds({
      groupBy,
      repos: visibleReposForRows,
      worktreesByRepo,
      visibleWorktrees,
      filterRepoIds
    })
  }, [filterRepoIds, groupBy, visibleReposForRows, visibleWorktrees, worktreesByRepo])
  const allRepoIds = useMemo(() => repos.map((r) => r.id), [repos])

  // Why: subscribe on a flat key array (useShallow) so progress ticks don't rebuild the whole row model.
  // Split on first space — creationId is a UUID (no space) so a space-containing repoId stays intact.
  const pendingCreationKeys = useAppStore(
    useShallow((s) =>
      Object.values(s.pendingWorktreeCreations ?? {}).map(
        (creation) => `${creation.creationId} ${creation.request.repoId}`
      )
    )
  )
  const pendingCreations = useMemo(
    () =>
      pendingCreationKeys.map((key) => {
        const separator = key.indexOf(' ')
        return { creationId: key.slice(0, separator), repoId: key.slice(separator + 1) }
      }),
    [pendingCreationKeys]
  )
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const hostOptions = useMemo(
    () =>
      buildSidebarHostOptions({
        repos,
        sshTargetLabels,
        sshConnectionStates,
        settings,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
      }),
    [
      repos,
      sshTargetLabels,
      sshConnectionStates,
      settings,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides
    ]
  )
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )

  const rows: Row[] = useMemo(
    () =>
      buildRows(
        groupBy,
        worktrees,
        repoMap,
        prCache,
        effectiveCollapsedGroups,
        repoOrder,
        workspaceStatuses,
        projectOrderBy,
        worktreeLineageById,
        worktreeMap,
        true,
        settings,
        visibleProjectGroupsForRows,
        placeholderRepoIds,
        importedWorktreesByRepo,
        newExternalWorktreesInboxByRepo,
        pendingCreations,
        projectGrouping,
        visibleFolderWorkspacesForRows,
        hostLabelById,
        defaultHostId,
        pinnedDisplayPolicy
      ),
    [
      groupBy,
      worktrees,
      repoMap,
      prCache,
      effectiveCollapsedGroups,
      defaultHostId,
      repoOrder,
      workspaceStatuses,
      projectOrderBy,
      worktreeLineageById,
      worktreeMap,
      settings,
      projectGrouping,
      visibleProjectGroupsForRows,
      visibleFolderWorkspacesForRows,
      placeholderRepoIds,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo,
      pendingCreations,
      hostLabelById,
      pinnedDisplayPolicy
    ]
  )
  const orderedHostOptions = useMemo(
    () => orderHostSectionOptions(hostOptions, workspaceHostOrder),
    [hostOptions, workspaceHostOrder]
  )
  const [hostDragActive, setHostDragActive] = useState(false)
  const handleReorderHostSections = useCallback(
    (orderedVisibleHostIds: ExecutionHostId[]) => {
      const visibleHostIds = new Set(orderedVisibleHostIds)
      const hostOptionIds = orderedHostOptions.map((host) => host.id)
      const knownHostIds = new Set(hostOptionIds)
      const nextOrder: ExecutionHostId[] = [...orderedVisibleHostIds]
      const seen = new Set(nextOrder)
      // Why: dragging only covers rendered hosts; keep non-rendered SSH/runtime hosts in the saved order so they return in place.
      for (const hostId of [...workspaceHostOrder, ...hostOptionIds]) {
        if (!knownHostIds.has(hostId) || visibleHostIds.has(hostId) || seen.has(hostId)) {
          continue
        }
        nextOrder.push(hostId)
        seen.add(hostId)
      }
      setWorkspaceHostOrder(nextOrder)
    },
    [orderedHostOptions, setWorkspaceHostOrder, workspaceHostOrder]
  )
  const sectionRows = useMemo(
    () =>
      addHostSectionRows({
        rows,
        hostOptions: orderedHostOptions,
        workspaceHostScope,
        visibleWorkspaceHostIds,
        defaultHostId,
        collapsedHostKeys: effectiveCollapsedGroups,
        forceCollapseHosts: hostDragActive,
        // Why: projects/workspaces are the primary sidebar object; host sections are only an explicit host-filter view.
        preferProjectGrouping: true
      }),
    [
      defaultHostId,
      effectiveCollapsedGroups,
      hostDragActive,
      orderedHostOptions,
      rows,
      visibleWorkspaceHostIds,
      workspaceHostScope
    ]
  )
  const renderedSidebarRowKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const row of sectionRows) {
      if (row.type === 'header') {
        keys.add(row.key)
      } else if (row.type === 'item') {
        keys.add(row.rowKey)
      } else if (row.type === 'folder-workspace') {
        keys.add(folderWorkspaceKey(row.folderWorkspace.id))
      } else if (row.type === 'pending-creation') {
        keys.add(`pending:${row.creationId}`)
      } else if (row.type === 'imported-worktrees-card') {
        keys.add(row.key)
      } else if (row.type === 'new-external-worktrees-inbox') {
        keys.add(row.key)
      }
    }
    return keys
  }, [sectionRows])
  // Why: status headers move during wake (inactive -> active); key only on grouping mode so row identity survives.
  const visibleHostResetKey = visibleWorkspaceHostIds?.join(',') ?? 'all'
  const viewportResetKey = `group:${groupBy}:host:${visibleHostResetKey}:lineage`

  // Why: derive order from the built rows, not the flat worktrees array, so Cmd+1–9 match visual positions when grouping reorders cards.
  const renderedWorktrees = useMemo(
    () => getRenderedWorktreesInSidebarOrder(sectionRows, pinnedDisplayPolicy),
    [pinnedDisplayPolicy, sectionRows]
  )
  // Why: order-preserving sectionRows rebuilds must not give this array a new
  // identity — updateSelectionForGesture depends on it, and a fresh identity
  // there defeats React.memo bail-out for every WorktreeCard on epoch bumps.
  const renderedWorktreeIds = useReusedArrayIdentity(
    useMemo(
      () => uniqueWorktreeIds(renderedWorktrees.map((worktree) => worktree.id)),
      [renderedWorktrees]
    )
  )
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<Set<string>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)

  const prunedSelection = pruneWorktreeSelection(
    selectedWorktreeIds,
    selectionAnchorId,
    renderedWorktreeIds
  )
  // Why: filters/grouping can hide selected cards; prune during render so nothing sees stale ids for unrendered worktrees.
  if (!areWorktreeSelectionsEqual(selectedWorktreeIds, prunedSelection.selectedIds)) {
    setSelectedWorktreeIds(prunedSelection.selectedIds)
  }
  if (selectionAnchorId !== prunedSelection.anchorId) {
    setSelectionAnchorId(prunedSelection.anchorId)
  }

  // Why identity reuse: the empty/unchanged-selection case must keep one array
  // identity — selectForContextMenu and both drag-start handlers depend on
  // this array, and card memo bail-out depends on those staying stable.
  const selectedWorktrees = useReusedArrayIdentity(
    useMemo(() => {
      if (selectedWorktreeIds.size === 0) {
        return []
      }
      const selected = new Map<string, Worktree>()
      for (const worktree of renderedWorktrees) {
        if (selectedWorktreeIds.has(worktree.id) && !selected.has(worktree.id)) {
          selected.set(worktree.id, worktree)
        }
      }
      return Array.from(selected.values())
    }, [renderedWorktrees, selectedWorktreeIds])
  )

  useEffect(() => {
    if (selectedWorktreeIds.size === 0) {
      return
    }

    const clearSelectionOutsideSidebar = (event: PointerEvent): void => {
      const target = event.target
      const sidebarContainer = document.querySelector('[data-worktree-sidebar-container]')
      if (target instanceof Node && sidebarContainer?.contains(target)) {
        return
      }
      setSelectedWorktreeIds(new Set())
      setSelectionAnchorId(null)
    }

    document.addEventListener('pointerdown', clearSelectionOutsideSidebar, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', clearSelectionOutsideSidebar, { capture: true })
    }
  }, [selectedWorktreeIds.size])

  const updateSelectionForGesture = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktreeId: string): boolean => {
      const intent = getWorktreeSelectionIntent(event, navigator.userAgent.includes('Mac'))
      const result = updateWorktreeSelection({
        visibleIds: renderedWorktreeIds,
        previousSelectedIds: selectedWorktreeIds,
        previousAnchorId: selectionAnchorId,
        targetId: worktreeId,
        intent
      })
      setSelectedWorktreeIds(result.selectedIds)
      setSelectionAnchorId(result.anchorId)
      // Plain click navigates; modifier gestures are selection-only so a batch can build without switching away.
      return intent !== 'replace'
    },
    [renderedWorktreeIds, selectedWorktreeIds, selectionAnchorId]
  )

  const selectForContextMenu = useCallback(
    (_event: React.MouseEvent<HTMLElement>, worktree: Worktree): readonly Worktree[] => {
      if (selectedWorktreeIds.has(worktree.id) && selectedWorktreeIds.size > 1) {
        return selectedWorktrees
      }
      setSelectedWorktreeIds(new Set([worktree.id]))
      setSelectionAnchorId(worktree.id)
      return [worktree]
    },
    [selectedWorktreeIds, selectedWorktrees]
  )

  const handleImmediateWorktreeActivate = useCallback((worktreeId: string, rowKey?: string) => {
    // Why: re-rendering the virtualized sidebar on the pointer path adds visible latency; mutate the row directly and let store state reconcile after.
    markSidebarWorktreeActiveImmediately(worktreeId, rowKey)
  }, [])

  // Why: full-page nav views aren't scoped to a worktree, so no sidebar card should look selected.
  const selectedSidebarWorktreeId =
    activeView === 'tasks' || activeView === 'activity' ? null : currentSidebarWorktreeId

  // Why layout effect: the Cmd/Ctrl+1–9 handler can fire right after commit; publishing after paint would leave the shortcut cache stale.
  useLayoutEffect(() => {
    setVisibleWorktreeIds(renderedWorktreeIds)
    // Why null, not []: [] is a real rendered order (all collapsed/filtered); null tells shortcuts the list is unmounted.
    return () => setVisibleWorktreeIds(null)
  }, [renderedWorktreeIds])

  const handleCreateForRepo = useCallback(
    (projectId: string) => {
      openModal('new-workspace-composer', { initialRepoId: projectId, telemetrySource: 'sidebar' })
    },
    [openModal]
  )

  const handleOpenRepoSettings = useCallback(
    (projectId: string, sectionId?: string) => {
      openSettingsTarget({ pane: 'repo', repoId: projectId, ...(sectionId ? { sectionId } : {}) })
      openSettingsPage()
    },
    [openSettingsPage, openSettingsTarget]
  )

  const handleOpenWorktreeVisibility = useCallback(
    (repo: Repo) => {
      openModal('worktree-visibility', {
        repoId: repo.id,
        hostId: getRepoExecutionHostId(repo)
      })
    },
    [openModal]
  )

  const setImportedWorktreeCardState = useCallback(
    (projectId: string, state: ImportedWorktreeCardActionState | null) => {
      setImportedWorktreeCardActionState((previous) => {
        const next = new Map(previous)
        if (state) {
          next.set(projectId, state)
        } else {
          next.delete(projectId)
        }
        return next
      })
    },
    []
  )

  const handleShowImportedWorktrees = useCallback(
    async (projectId: string) => {
      await showImportedWorktreesCard({
        projectId,
        forceVisible: importedWorktreeCardActionState.get(projectId)?.forceVisible === true,
        updateRepo,
        fetchWorktrees,
        setCardState: setImportedWorktreeCardState
      })
    },
    [fetchWorktrees, importedWorktreeCardActionState, setImportedWorktreeCardState, updateRepo]
  )

  const handleKeepImportedWorktreesHidden = useCallback(
    async (projectId: string) => {
      const repo = repos.find((candidate) => candidate.id === projectId)
      let detected = detectedWorktreesByRepo[projectId]
      // Why: baseline seeding needs authoritative hidden paths, so don't dismiss on a stale snapshot.
      if (detected?.authoritative !== true) {
        const refreshed = await fetchWorktrees(projectId, { requireAuthoritative: true })
        if (!refreshed) {
          setImportedWorktreeCardState(projectId, {
            pending: false,
            error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
          })
          return
        }
        detected = useAppStore.getState().detectedWorktreesByRepo[projectId]
      }
      if (detected?.authoritative !== true) {
        setImportedWorktreeCardState(projectId, {
          pending: false,
          error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
        })
        return
      }
      const hiddenWorktrees = getHiddenImportedWorktrees(detected)
      await keepImportedWorktreesHiddenCard({
        projectId,
        updateRepo,
        setCardState: setImportedWorktreeCardState,
        hiddenWorktreePaths: hiddenWorktrees.map((worktree) => worktree.path),
        existingBaselinePaths: repo?.externalWorktreeInboxBaselinePaths
      })
    },
    [detectedWorktreesByRepo, fetchWorktrees, repos, setImportedWorktreeCardState, updateRepo]
  )

  const setNewExternalWorktreeInboxState = useCallback(
    (projectId: string, state: NewExternalWorktreesInboxActionState | null) => {
      setNewExternalWorktreeInboxActionState((previous) => {
        const next = new Map(previous)
        if (state) {
          next.set(projectId, state)
        } else {
          next.delete(projectId)
        }
        return next
      })
    },
    []
  )

  const getNewExternalWorktreeInboxActionArgs = useCallback(
    (projectId: string, worktreePaths: readonly string[]) => {
      const repo = repos.find((candidate) => candidate.id === projectId)
      if (!repo) {
        return null
      }
      return {
        projectId,
        repo,
        worktreePaths,
        updateRepo,
        fetchWorktrees,
        setInboxState: setNewExternalWorktreeInboxState
      }
    },
    [fetchWorktrees, repos, setNewExternalWorktreeInboxState, updateRepo]
  )

  const handleOpenSuppressExternalWorktreeInbox = useCallback((projectId: string) => {
    setSuppressExternalWorktreeInboxRepoId(projectId)
  }, [])

  const handleConfirmSuppressExternalWorktreeInbox = useCallback(async () => {
    if (!suppressExternalWorktreeInboxRepoId) {
      return
    }
    const projectId = suppressExternalWorktreeInboxRepoId
    const inboxWorktrees = newExternalWorktreesInboxByRepo.get(projectId)?.inboxWorktrees ?? []
    const args = getNewExternalWorktreeInboxActionArgs(
      projectId,
      inboxWorktrees.map((worktree) => worktree.path)
    )
    if (!args) {
      setSuppressExternalWorktreeInboxRepoId(null)
      return
    }
    const suppressed = await suppressNewExternalWorktreeInbox(args)
    if (suppressed) {
      setSuppressExternalWorktreeInboxRepoId(null)
    }
  }, [
    getNewExternalWorktreeInboxActionArgs,
    newExternalWorktreesInboxByRepo,
    suppressExternalWorktreeInboxRepoId
  ])

  const handleRemoveProject = useCallback(
    (repo: Repo) => {
      openModal('confirm-remove-folder', {
        repoId: repo.id,
        displayName: repo.displayName,
        hostId: getRepoExecutionHostId(repo)
      })
    },
    [openModal]
  )

  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const deleteProjectGroupWithContainedProjects = useAppStore(
    (s) => s.deleteProjectGroupWithContainedProjects
  )
  const [projectGroupNameDialog, setProjectGroupNameDialog] =
    useState<ProjectGroupNameDialogState | null>(null)
  const [projectGroupDeleteDialog, setProjectGroupDeleteDialog] =
    useState<ProjectGroupDeleteDialogState | null>(null)

  const handleCreateGroupFromRepo = useCallback((repo: Repo) => {
    setProjectGroupNameDialog({ type: 'create-from-repo', repo })
  }, [])

  const handleMoveProjectToGroup = useCallback(
    (repo: Repo, groupId: string) => {
      if (repo.projectGroupId === groupId) {
        return
      }
      void moveProjectToGroup(repo.id, groupId)
    },
    [moveProjectToGroup]
  )

  const handleRemoveProjectFromGroup = useCallback(
    (repo: Repo) => {
      void moveProjectToGroup(repo.id, null)
    },
    [moveProjectToGroup]
  )

  const handleRenameProjectGroup = useCallback((groupId: string, currentName: string) => {
    setProjectGroupNameDialog({ type: 'rename', groupId, currentName })
  }, [])

  const handleSubmitProjectGroupName = useCallback(
    async (name: string) => {
      if (!projectGroupNameDialog) {
        return
      }
      if (projectGroupNameDialog.type === 'create-from-repo') {
        const group = await createProjectGroup(name)
        if (group) {
          await moveProjectToGroup(projectGroupNameDialog.repo.id, group.id)
        }
        return
      }
      await updateProjectGroup(projectGroupNameDialog.groupId, { name })
    },
    [createProjectGroup, moveProjectToGroup, projectGroupNameDialog, updateProjectGroup]
  )

  const projectGroupDeleteTargets = useMemo(() => {
    if (!projectGroupDeleteDialog) {
      return null
    }
    return selectProjectGroupRemovalTargets(projectGroups, repos, projectGroupDeleteDialog.groupId)
  }, [projectGroupDeleteDialog, projectGroups, repos])
  const projectGroupDeleteProjectCount = projectGroupDeleteTargets?.projectIds.length ?? 0
  const projectGroupDeleteProjectNames = useMemo(
    () =>
      (projectGroupDeleteTargets?.projectIds ?? []).map(
        (projectId) => repoMap.get(projectId)?.displayName ?? projectId
      ),
    [projectGroupDeleteTargets, repoMap]
  )
  const projectGroupRemoveContainedProjects =
    projectGroupDeleteProjectCount > 0 && projectGroupDeleteDialog?.removeContainedProjects === true

  const handleDeleteProjectGroup = useCallback((groupId: string, groupName: string) => {
    setProjectGroupDeleteDialog({ groupId, groupName, removeContainedProjects: false })
  }, [])

  const handleConfirmDeleteProjectGroup = useCallback(async () => {
    if (!projectGroupDeleteDialog) {
      return
    }
    try {
      const result = await deleteProjectGroupWithContainedProjects(
        projectGroupDeleteDialog.groupId,
        {
          removeContainedProjects: projectGroupRemoveContainedProjects
        }
      )
      // Why: a missing group is already the desired end state, so only a real delete failure warrants a toast.
      if (result.status === 'group-delete-failed') {
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.groupDeleteFailed',
            'Failed to delete group'
          ),
          {
            description: translate(
              'auto.components.sidebar.WorktreeList.groupDeleteFailedDesc',
              'Something went wrong while deleting the group. No projects were removed.'
            )
          }
        )
        return
      }
      if (result.status === 'deleted-group' && result.failedProjectRemovals.length > 0) {
        const failedCount = result.failedProjectRemovals.length
        const requestedCount = result.requestedProjectIds.length
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.b667b59632',
            'Some projects could not be removed from Orca'
          ),
          {
            description: translate(
              'auto.components.sidebar.WorktreeList.f94466bc39',
              '{{value0}} of {{value1}} contained project{{value2}} remained after deleting the group.',
              {
                value0: failedCount,
                value1: requestedCount,
                value2: requestedCount === 1 ? '' : 's'
              }
            )
          }
        )
      }
    } finally {
      // Why: deleting contained projects can unmount this dialog before its close handler runs, so the parent owns cleanup.
      setProjectGroupDeleteDialog(null)
    }
  }, [
    deleteProjectGroupWithContainedProjects,
    projectGroupRemoveContainedProjects,
    projectGroupDeleteDialog
  ])

  const handleCreateFolderWorkspace = useCallback(
    (projectGroup: ProjectGroup) => {
      if (!projectGroup.parentPath) {
        return
      }
      openModal('new-workspace-composer', {
        initialProjectGroupId: projectGroup.id,
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  const moveWorktreeToStatus = useCallback(
    (worktreeId: string, status: WorkspaceStatus) => {
      const current = worktreeMap.get(worktreeId)
      if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
        return
      }
      void updateWorktreeMeta(worktreeId, { workspaceStatus: status })
    },
    [updateWorktreeMeta, worktreeMap, workspaceStatuses]
  )

  const moveWorktreesToStatus = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const updates = new Map<string, { workspaceStatus: WorkspaceStatus }>()
      for (const worktreeId of worktreeIds) {
        const current = worktreeMap.get(worktreeId)
        if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
          continue
        }
        updates.set(worktreeId, { workspaceStatus: status })
      }
      if (updates.size > 0) {
        void updateWorktreesMeta(updates)
      }
    },
    [updateWorktreesMeta, worktreeMap, workspaceStatuses]
  )

  const moveWorktreesToStatusAtIndex = useCallback(
    (args: {
      worktreeIds: readonly string[]
      status: WorkspaceStatus
      dropIndex: number
      groups: readonly WorktreeDragGroup[]
    }) => {
      const targetGroupKey = getWorkspaceStatusGroupKey(args.status)
      const rankByWorktreeId = new Map<string, number>()
      for (const group of args.groups) {
        for (const worktreeId of group.worktreeIds) {
          const worktree = worktreeMap.get(worktreeId)
          if (worktree) {
            rankByWorktreeId.set(worktreeId, worktree.manualOrder ?? worktree.sortOrder)
          }
        }
      }
      const order = buildManualOrderUpdatesForGroupDrop({
        groups: args.groups,
        targetGroupKey,
        draggedIds: args.worktreeIds,
        dropIndex: args.dropIndex,
        now: Date.now(),
        rankByWorktreeId
      })
      const updates = new Map<string, Partial<WorktreeMeta>>()
      for (const worktreeId of args.worktreeIds) {
        const current = worktreeMap.get(worktreeId)
        if (!current) {
          continue
        }
        const next: Partial<WorktreeMeta> = {}
        if (getWorkspaceStatus(current, workspaceStatuses) !== args.status) {
          next.workspaceStatus = args.status
        }
        updates.set(worktreeId, next)
      }
      for (const [worktreeId, manualOrder] of order.updates) {
        updates.set(worktreeId, { ...updates.get(worktreeId), ...manualOrder })
      }
      for (const [worktreeId, update] of Array.from(updates)) {
        if (Object.keys(update).length === 0) {
          updates.delete(worktreeId)
        }
      }
      if (updates.size === 0) {
        return
      }
      // Why: the insertion line promises exact placement, so persist manual order on a cross-status drop.
      if (order.changed) {
        setSortBy('manual')
      }
      void updateWorktreesMeta(updates)
    },
    [setSortBy, updateWorktreesMeta, worktreeMap, workspaceStatuses]
  )

  const pinWorktree = useCallback(
    (worktreeId: string) => {
      setWorktreesPinnedAndReveal([worktreeId], true)
    },
    [setWorktreesPinnedAndReveal]
  )

  const pinWorktrees = useCallback(
    (worktreeIds: readonly string[]) => {
      setWorktreesPinnedAndReveal(worktreeIds, true)
    },
    [setWorktreesPinnedAndReveal]
  )

  const reorderWorktrees = useCallback(
    (args: {
      groups: readonly WorktreeDragGroup[]
      sourceGroupKey: string
      draggedIds: readonly string[]
      dropIndex: number
    }) => {
      const rankByWorktreeId = new Map<string, number>()
      for (const group of args.groups) {
        for (const worktreeId of group.worktreeIds) {
          const worktree = worktreeMap.get(worktreeId)
          if (worktree) {
            rankByWorktreeId.set(worktreeId, worktree.manualOrder ?? worktree.sortOrder)
          }
        }
      }
      const result = buildManualOrderUpdatesForVisibleGroups({
        ...args,
        now: Date.now(),
        rankByWorktreeId
      })
      if (!result.changed) {
        return
      }
      // Why: only switch to Manual after a real move so accidental click-drags don't change the sort.
      setSortBy('manual')
      void updateWorktreesMeta(result.updates)
    },
    [setSortBy, updateWorktreesMeta, worktreeMap]
  )

  const shouldShowWorkspaceBoardDropIndicator = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const sourceGroupKeys = worktreeIds.flatMap((worktreeId) => {
        const worktree = worktreeMap.get(worktreeId)
        return worktree ? [getWorkspaceStatus(worktree, workspaceStatuses)] : []
      })
      return shouldWriteManualOrderForGroupDrop({
        sortBy,
        sourceGroupKeys,
        targetGroupKey: status
      })
    },
    [sortBy, worktreeMap, workspaceStatuses]
  )

  const dropWorktreesOnWorkspaceBoard = useCallback(
    (args: {
      worktreeIds: readonly string[]
      status: WorkspaceStatus
      dropIndex: number
      groups: readonly WorktreeDragGroup[]
    }) => {
      const result = buildWorkspaceKanbanSidebarDropUpdates({
        ...args,
        worktreeById: worktreeMap,
        workspaceStatuses,
        sortBy,
        now: Date.now()
      })
      if (result.updates.size === 0) {
        return
      }
      // Why: switch to Manual when the drop changes order so the placement stays visible.
      if (result.shouldSwitchToManual) {
        setSortBy('manual')
      }
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
      void updateWorktreesMeta(result.updates)
    },
    [setSortBy, sortBy, updateWorktreesMeta, worktreeMap, workspaceStatuses]
  )

  // Why: count hideDefaultBranchWorkspace as a filter so the Clear Filters escape hatch stays reachable when it alone empties the list.
  const filterState = useMemo(
    () => ({
      showSleepingWorkspaces,
      filterRepoIds,
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      alwaysShowDefaultBranchWorkspace,
      visibleWorkspaceHostIds,
      workspaceHostScope
    }),
    [
      showSleepingWorkspaces,
      filterRepoIds,
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      alwaysShowDefaultBranchWorkspace,
      visibleWorkspaceHostIds,
      workspaceHostScope
    ]
  )
  const hasFilters = sidebarHasActiveFilters(filterState)
  const setShowSleepingWorkspaces = useAppStore((s) => s.setShowSleepingWorkspaces)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const setHideAutomationGeneratedWorkspaces = useAppStore(
    (s) => s.setHideAutomationGeneratedWorkspaces
  )
  const setHideCliCreatedWorkspaces = useAppStore((s) => s.setHideCliCreatedWorkspaces)
  const setHideDetachedHeadWorkspaces = useAppStore((s) => s.setHideDetachedHeadWorkspaces)
  const setHideWorkspacesFromOtherDevices = useAppStore((s) => s.setHideWorkspacesFromOtherDevices)
  const setAlwaysShowDefaultBranchWorkspace = useAppStore(
    (s) => s.setAlwaysShowDefaultBranchWorkspace
  )
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)

  const clearFilters = useCallback(() => {
    const actions = computeClearFilterActions(filterState)
    if (actions.resetShowSleepingWorkspaces) {
      setShowSleepingWorkspaces(DEFAULT_SHOW_SLEEPING_WORKSPACES)
    }
    if (actions.resetFilterRepoIds) {
      setFilterRepoIds([])
    }
    if (actions.resetHideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    if (actions.resetHideAutomationGeneratedWorkspaces) {
      setHideAutomationGeneratedWorkspaces(false)
    }
    if (actions.resetHideCliCreatedWorkspaces) {
      setHideCliCreatedWorkspaces(false)
    }
    if (actions.resetHideDetachedHeadWorkspaces) {
      setHideDetachedHeadWorkspaces(false)
    }
    if (actions.resetHideWorkspacesFromOtherDevices) {
      setHideWorkspacesFromOtherDevices(false)
    }
    if (actions.resetAlwaysShowDefaultBranchWorkspace) {
      setAlwaysShowDefaultBranchWorkspace(true)
    }
    if (actions.resetVisibleWorkspaceHostIds) {
      setVisibleWorkspaceHostIds(null)
    }
  }, [
    setShowSleepingWorkspaces,
    setFilterRepoIds,
    setHideDefaultBranchWorkspace,
    setHideAutomationGeneratedWorkspaces,
    setHideCliCreatedWorkspaces,
    setHideDetachedHeadWorkspaces,
    setHideWorkspacesFromOtherDevices,
    setAlwaysShowDefaultBranchWorkspace,
    setVisibleWorkspaceHostIds,
    filterState
  ])

  useEffect(() => {
    if (!pendingRevealSidebarRow) {
      return
    }
    const rowKey = pendingRevealSidebarRow.rowKey
    const isProjectHeaderTarget =
      rowKey.startsWith('project-group:') ||
      rowKey.startsWith('project:') ||
      rowKey.startsWith('repo:')
    if (isProjectHeaderTarget && groupBy !== 'repo') {
      setGroupBy('repo')
      return
    }
    if (!renderedSidebarRowKeys.has(rowKey) && hasFilters) {
      clearFilters()
    }
  }, [
    clearFilters,
    groupBy,
    hasFilters,
    pendingRevealSidebarRow,
    renderedSidebarRowKeys,
    setGroupBy
  ])

  const handleRevealCurrentWorkspaceRequest = useCallback(
    (event: Event) => {
      const detail =
        event instanceof CustomEvent
          ? (event.detail as ScrollToCurrentWorkspaceRevealRequestDetail | undefined)
          : undefined
      if (detail?.target?.type === 'sidebar-row') {
        const sidebarDetail = detail as Extract<
          ScrollToCurrentWorkspaceRevealRequestDetail,
          { target: { type: 'sidebar-row' } }
        >
        revealSidebarRow(detail.target.rowKey, {
          behavior: 'smooth',
          highlight: sidebarDetail.highlight !== false
        })
        return
      }
      if (!currentSidebarWorktreeId) {
        return
      }
      const activeWorktree = getKnownSidebarWorktreeById(
        currentSidebarWorktreeId,
        worktreeMap,
        folderWorkspaces
      )
      if (!activeWorktree || activeWorktree.isArchived) {
        return
      }
      if (!renderedWorktreeIds.includes(currentSidebarWorktreeId)) {
        // Why: the reveal action must show the current workspace, so relax filters that hide it first.
        clearFilters()
      }
      revealWorktreeInSidebar(currentSidebarWorktreeId, {
        behavior: 'smooth',
        highlight: true,
        beginRename: (detail as { beginRename?: boolean } | undefined)?.beginRename === true
      })
    },
    [
      clearFilters,
      currentSidebarWorktreeId,
      folderWorkspaces,
      revealSidebarRow,
      renderedWorktreeIds,
      revealWorktreeInSidebar,
      worktreeMap
    ]
  )

  useEffect(() => {
    window.addEventListener(
      SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
      handleRevealCurrentWorkspaceRequest
    )
    return () => {
      window.removeEventListener(
        SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
        handleRevealCurrentWorkspaceRequest
      )
    }
  }, [handleRevealCurrentWorkspaceRequest])

  const filtersHideAllRows =
    hasFilters &&
    worktrees.length === 0 &&
    placeholderRepoIds.size === 0 &&
    importedWorktreesByRepo.size === 0
  // Why: when active filters hide every row, the Clear Filters empty state must win over Project Group headers.
  if (rows.length === 0 || filtersHideAllRows) {
    return (
      <div
        data-worktree-sidebar-container
        data-contextual-tour-target="workspace-list"
        className="relative min-h-0 flex-1"
      >
        <div className="worktree-sidebar-scrollbar flex h-full flex-col overflow-y-auto overflow-x-hidden pl-1 scrollbar-sleek pt-px">
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-[11px] text-muted-foreground">
            <span>
              {translate('auto.components.sidebar.WorktreeList.b7acbf038b', 'No workspaces found')}
            </span>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-[11px] px-2.5 py-1 rounded-md cursor-pointer hover:bg-accent transition-colors"
              >
                <CircleX className="size-3.5" />
                {translate('auto.components.sidebar.WorktreeList.370c6a55dd', 'Clear Filters')}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <ProjectGroupNameDialog
        open={projectGroupNameDialog !== null}
        title={
          projectGroupNameDialog?.type === 'rename'
            ? translate('auto.components.sidebar.WorktreeList.f9dc6cc5d3', 'Rename Project Group')
            : translate('auto.components.sidebar.WorktreeList.13757c053c', 'New Project Group')
        }
        description={
          projectGroupNameDialog?.type === 'rename'
            ? translate(
                'auto.components.sidebar.WorktreeList.bc1460beb3',
                'Update the group name shown in the sidebar.'
              )
            : translate(
                'auto.components.sidebar.WorktreeList.d880ea0744',
                'Create a group and move this project into it.'
              )
        }
        initialName={
          projectGroupNameDialog?.type === 'rename'
            ? projectGroupNameDialog.currentName
            : projectGroupNameDialog
              ? `${projectGroupNameDialog.repo.displayName} group`
              : ''
        }
        confirmLabel={projectGroupNameDialog?.type === 'rename' ? 'Rename' : 'Create'}
        onOpenChange={(open) => {
          if (!open) {
            setProjectGroupNameDialog(null)
          }
        }}
        onSubmit={handleSubmitProjectGroupName}
      />
      <SuppressExternalWorktreeInboxDialog
        open={suppressExternalWorktreeInboxRepoId !== null}
        repoDisplayName={
          suppressExternalWorktreeInboxRepoId
            ? (repos.find((repo) => repo.id === suppressExternalWorktreeInboxRepoId)?.displayName ??
              '')
            : ''
        }
        pending={
          suppressExternalWorktreeInboxRepoId
            ? (newExternalWorktreeInboxActionState.get(suppressExternalWorktreeInboxRepoId)
                ?.pending ?? false)
            : false
        }
        onOpenChange={(open) => {
          if (!open) {
            setSuppressExternalWorktreeInboxRepoId(null)
          }
        }}
        onConfirm={() => {
          void handleConfirmSuppressExternalWorktreeInbox()
        }}
        onOpenRecovery={() => {
          if (!suppressExternalWorktreeInboxRepoId) {
            return
          }
          const repo = findRepoForHost(repos, suppressExternalWorktreeInboxRepoId, { settings })
          setSuppressExternalWorktreeInboxRepoId(null)
          if (repo) {
            handleOpenWorktreeVisibility(repo)
          }
        }}
      />
      <ProjectGroupDeleteDialog
        open={projectGroupDeleteDialog !== null}
        groupName={projectGroupDeleteDialog?.groupName ?? ''}
        projectCount={projectGroupDeleteProjectCount}
        projectNames={projectGroupDeleteProjectNames}
        removeContainedProjects={projectGroupRemoveContainedProjects}
        onRemoveContainedProjectsChange={(removeContainedProjects) => {
          setProjectGroupDeleteDialog((current) =>
            current ? { ...current, removeContainedProjects } : current
          )
        }}
        onOpenChange={(open) => {
          if (!open) {
            setProjectGroupDeleteDialog(null)
          }
        }}
        onConfirm={handleConfirmDeleteProjectGroup}
      />
      <VirtualizedWorktreeViewport
        key={viewportResetKey}
        rows={sectionRows}
        activeWorktreeId={selectedSidebarWorktreeId}
        currentWorktreeId={currentSidebarWorktreeId}
        groupBy={groupBy}
        pinnedDisplayPolicy={pinnedDisplayPolicy}
        projectOrderBy={projectOrderBy}
        toggleGroup={toggleGroup}
        collapsedGroups={effectiveCollapsedGroups}
        handleCreateForRepo={handleCreateForRepo}
        handleOpenRepoSettings={handleOpenRepoSettings}
        handleOpenWorktreeVisibility={handleOpenWorktreeVisibility}
        handleShowImportedWorktrees={handleShowImportedWorktrees}
        handleKeepImportedWorktreesHidden={handleKeepImportedWorktreesHidden}
        importedWorktreeCardActionState={importedWorktreeCardActionState}
        handleOpenSuppressExternalWorktreeInbox={handleOpenSuppressExternalWorktreeInbox}
        newExternalWorktreeInboxActionState={newExternalWorktreeInboxActionState}
        handleRemoveProject={handleRemoveProject}
        handleCreateGroupFromRepo={handleCreateGroupFromRepo}
        handleMoveProjectToGroup={handleMoveProjectToGroup}
        handleRemoveProjectFromGroup={handleRemoveProjectFromGroup}
        handleRenameProjectGroup={handleRenameProjectGroup}
        handleDeleteProjectGroup={handleDeleteProjectGroup}
        handleCreateFolderWorkspace={handleCreateFolderWorkspace}
        activeModal={activeModal}
        pendingRevealWorktree={pendingRevealWorktree}
        pendingRevealSidebarRow={pendingRevealSidebarRow}
        clearPendingRevealWorktreeId={clearPendingRevealWorktreeId}
        clearPendingRevealSidebarRow={clearPendingRevealSidebarRow}
        agentSendTargetWorktreeId={agentSendTargetWorktreeId}
        worktrees={worktrees}
        folderWorkspaces={folderWorkspaces}
        selectedWorktreeIds={selectedWorktreeIds}
        selectedWorktrees={selectedWorktrees}
        onSelectionGesture={updateSelectionForGesture}
        onImmediateWorktreeActivate={handleImmediateWorktreeActivate}
        onContextMenuSelect={selectForContextMenu}
        repoMap={repoMap}
        defaultHostId={defaultHostId}
        worktreeMap={worktreeMap}
        worktreeLineageById={worktreeLineageById}
        workspaceLineageByChildKey={workspaceLineageByChildKey}
        allRepoIds={allRepoIds}
        onReorderHostSections={handleReorderHostSections}
        onHostDragActiveChange={setHostDragActive}
        prCache={prCache}
        hostedReviewCache={hostedReviewCache}
        workspaceStatuses={workspaceStatuses}
        projectGrouping={projectGrouping}
        projectGroups={projectGroups}
        onMoveWorktreeToStatus={moveWorktreeToStatus}
        onMoveWorktreesToStatus={moveWorktreesToStatus}
        onMoveWorktreesToStatusAtIndex={moveWorktreesToStatusAtIndex}
        onPinWorktree={pinWorktree}
        onPinWorktrees={pinWorktrees}
        onDropWorktreesOnWorkspaceBoard={dropWorktreesOnWorkspaceBoard}
        workspaceBoardOpen={workspaceBoardOpen}
        onWorkspaceBoardDragPreviewStart={onWorkspaceBoardDragPreviewStart}
        onWorkspaceBoardDragPreviewCommit={onWorkspaceBoardDragPreviewCommit}
        onWorkspaceBoardDragPreviewCancel={onWorkspaceBoardDragPreviewCancel}
        shouldShowWorkspaceBoardDropIndicator={shouldShowWorkspaceBoardDropIndicator}
        onReorderWorktrees={reorderWorktrees}
        scrollOffsetRef={scrollOffsetRef}
        scrollAnchorRef={scrollAnchorRef}
      />
    </>
  )
})

export default WorktreeList
