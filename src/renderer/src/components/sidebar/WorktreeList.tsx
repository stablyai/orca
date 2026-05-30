/* eslint-disable max-lines */
import React, { useMemo, useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react'
import {
  defaultRangeExtractor,
  measureElement as measureVirtualElementSize,
  useVirtualizer
} from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import {
  ChevronDown,
  CircleX,
  Ellipsis,
  Eye,
  FolderInput,
  FolderPlus,
  Plus,
  Shapes,
  SlidersHorizontal,
  Trash2,
  Workflow
} from 'lucide-react'
import { useAppStore } from '@/store'
import {
  getAllWorktreesFromState,
  useAllWorktrees,
  useRepoMap,
  useWorktreeMap
} from '@/store/selectors'
import WorktreeCard from './WorktreeCard'
import WorktreeCardAgents, {
  SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT
} from './WorktreeCardAgents'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import { WorktreeActivityStatusIndicator } from './WorktreeActivityStatusIndicator'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type {
  Worktree,
  Repo,
  ProjectGroup,
  WorktreeLineage,
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import { buildWorktreeComparator } from './smart-sort'
import {
  buildAttentionByWorktree,
  type SmartClass,
  type WorktreeAttention
} from './smart-attention'
import { track } from '@/lib/telemetry'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  type GroupHeaderRow,
  type ProjectGroupOrdering,
  type Row,
  type WorktreeGroupBy,
  ALL_GROUP_KEY,
  PINNED_GROUP_KEY,
  buildRows,
  getGroupKeysForWorktree,
  getProjectGroupOrdering,
  getLineageGroupKey
} from './worktree-list-groups'
import {
  estimateRenderRowSize,
  getActiveStickyHeaderIndex,
  getActiveStickyHeaderIndexForScroll,
  getPreviousStickyHeaderIndex,
  getStickyHeaderIndexes,
  getVirtualRowTransform,
  shouldUseHeaderTopSpacing,
  type RenderRow
} from './worktree-list-virtual-rows'
import {
  revealElementInScrollContainer,
  WORKTREE_SIDEBAR_REVEAL_TOP_INSET
} from './worktree-sidebar-reveal'
import {
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  hasWorkspaceDragData,
  readWorkspaceDragDataIds
} from './workspace-status'
import { useWorkspaceStatusDocumentDrop } from './use-workspace-status-drop'
import {
  computeClearFilterActions,
  computeVisibleWorktreeIds,
  setVisibleWorktreeIds,
  sidebarHasActiveFilters
} from './visible-worktrees'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs
} from './visible-worktree-activity-inputs'
import {
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT,
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT } from '@/lib/scroll-to-current-workspace-status'
import { useRepoHeaderDrag } from './project-header-drag'
import WorktreeContextMenu from './WorktreeContextMenu'
import {
  buildWorktreeDragPreviewOffsets,
  buildManualOrderUpdatesForVisibleGroups,
  expandDraggedWorktreeIdsForVisibleLineage,
  shouldWriteManualOrderForGroupDrop,
  type WorktreeDragGroup
} from './worktree-manual-order'
import {
  buildWorkspaceKanbanSidebarDropUpdates,
  clearWorkspaceKanbanSidebarDropTargetVisual,
  getWorkspaceKanbanSidebarDropGroups,
  getWorkspaceKanbanSidebarDropTarget,
  hasWorkspaceKanbanSidebarDropBoard,
  updateWorkspaceKanbanSidebarDropTargetVisual
} from './workspace-kanban-sidebar-drop'
import {
  getFullDropIndexForWorktreeDragUnit,
  getWorktreeDragUnitGroups
} from './worktree-drag-units'
import {
  createSidebarDragPreview,
  isSidebarPointerDragBlocked,
  setSidebarPointerDragDocumentStyles,
  updateSidebarDragPreviewPosition
} from './worktree-sidebar-pointer-drag-dom'
import {
  getWorktreeSidebarDragAutoscroll,
  getWorktreeSidebarBoundaryDrop,
  getWorktreeSidebarDragRectsForGroup,
  refreshWorktreeSidebarDragSession,
  type WorktreeSidebarDragRect,
  type WorktreeSidebarDragSession,
  type WorktreeSidebarDragPoint
} from './worktree-sidebar-drag-autoscroll'
import { resolveProjectGroupHeaderColor } from './project-header-color'
import {
  areWorktreeSelectionsEqual,
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeSelection
} from './worktree-multi-selection'
import { branchDisplayName } from './WorktreeCardHelpers'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRepoHeaderCreateState } from './repo-header-create-state'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { getRepositoryIconSectionId } from '@/components/settings/repository-settings-targets'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { ProjectGroupDeleteDialog } from './ProjectGroupDeleteDialog'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import ImportedWorktreesVisibilityCard from './ImportedWorktreesVisibilityCard'
import {
  keepImportedWorktreesHiddenCard,
  showImportedWorktreesCard,
  type ImportedWorktreeCardActionState
} from './imported-worktrees-card-actions'
import { buildImportedWorktreesCardCandidates } from './imported-worktrees-card-candidates'
import {
  buildWorktreeSectionActivitySummaries,
  EMPTY_WORKTREE_SECTION_ACTIVITY,
  type WorktreeSectionActivityState,
  type WorktreeSectionActivitySummary
} from './worktree-section-activity'

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
}

// How long to wait after a sortEpoch bump before actually re-sorting.
// Prevents jarring position shifts when background events (AI starting work,
// terminal title changes) trigger score recalculations.
const SORT_SETTLE_MS = 3_000
const USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS = 500
const EMPTY_PROJECT_GROUPS: readonly ProjectGroup[] = []
const EXPANDING_CARD_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS = 300
const WORKTREE_SIDEBAR_SCROLL_STYLE: React.CSSProperties = {
  // Why: TanStack Virtual owns scroll correction. Native browser anchoring can
  // fight virtual row measurement/remounts and produce visible jumps.
  overflowAnchor: 'none'
}

const recordKeyCountCache = new WeakMap<Record<string, unknown>, number>()

export function countRecordKeysByReference(record: Record<string, unknown>): number {
  const cached = recordKeyCountCache.get(record)
  if (cached !== undefined) {
    return cached
  }
  const count = Object.keys(record).length
  recordKeyCountCache.set(record, count)
  return count
}

export function shouldAdjustWorktreeSidebarMeasuredRowScroll(args: {
  isScrolling: boolean
  now: number
  suppressUntil: number
}): boolean {
  return !args.isScrolling && args.now >= args.suppressUntil
}

export function resolvePendingSidebarReveal(args: {
  targetIndex: number
  targetWorktreeStillExists: boolean
}): 'scroll-and-clear' | 'clear' | 'keep-pending' {
  if (args.targetIndex !== -1) {
    return 'scroll-and-clear'
  }
  return args.targetWorktreeStillExists ? 'keep-pending' : 'clear'
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm uses a hidden textarea for terminal input. Treating it like a normal
  // text field would make the sidebar's app-level worktree shortcuts unreachable.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

function stopRepoHeaderKeyboardToggle(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.stopPropagation()
  }
}

function stopNestedWorktreeCardBubble(event: React.SyntheticEvent<HTMLElement>): void {
  event.stopPropagation()
}

function getWorktreeOptionId(worktreeId: string): string {
  return `worktree-list-option-${encodeURIComponent(worktreeId)}`
}

function revealMountedWorktreeElement(
  container: HTMLElement,
  worktreeId: string,
  behavior: ScrollBehavior
): boolean {
  const element = document.getElementById(getWorktreeOptionId(worktreeId))
  if (!element || !container.contains(element)) {
    return false
  }
  return revealElementInScrollContainer(container, element, behavior)
}

function getWorktreeVisibilityMenuLabel(repo: Repo): string {
  const visibility = effectiveExternalWorktreeVisibility(
    repo,
    isLegacyRepoForExternalWorktreeVisibility(repo)
  )
  return visibility === 'show' ? 'Hide non-Orca worktrees' : 'Import Worktrees'
}

const LINEAGE_INDENT = 18
// Why: top-level worktrees are children of their project header; indent the
// group one step so the status dots nest under the folder icon for hierarchy.
const WORKTREE_GROUP_INDENT = 18
const PROJECT_GROUP_HEADER_INDENT = 10
const SIDEBAR_POINTER_DRAG_THRESHOLD_PX = 4

type VirtualizedWorktreeViewportProps = {
  rows: Row[]
  activeWorktreeId: string | null
  currentWorktreeId: string | null
  groupBy: WorktreeGroupBy
  projectGroupOrdering: ProjectGroupOrdering
  toggleGroup: (key: string) => void
  collapsedGroups: Set<string>
  handleCreateForRepo: (projectId: string) => void
  handleOpenRepoSettings: (projectId: string, sectionId?: string) => void
  handleOpenWorktreeVisibility: (projectId: string) => void
  handleShowImportedWorktrees: (projectId: string) => void
  handleKeepImportedWorktreesHidden: (projectId: string) => void
  importedWorktreeCardActionState: ReadonlyMap<string, ImportedWorktreeCardActionState>
  handleRemoveProject: (repo: Repo) => void
  handleCreateGroupFromRepo: (repo: Repo) => void
  handleMoveProjectToGroup: (repo: Repo, groupId: string) => void
  handleRemoveProjectFromGroup: (repo: Repo) => void
  handleRenameProjectGroup: (groupId: string, currentName: string) => void
  handleDeleteProjectGroup: (groupId: string, groupName: string) => void
  activeModal: string
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  clearPendingRevealWorktreeId: () => void
  worktrees: Worktree[]
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  repoOrder: Map<string, number>
  // The full canonical state.repos id ordering — the drag controller commits
  // permutations of this list, even when some repos aren't currently visible
  // (filtered out / collapsed-only). Visible-only ids would silently drop the
  // hidden repos on reorder.
  allRepoIds: string[]
  reorderRepos: (orderedIds: string[]) => void
  prCache: Record<string, unknown> | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups?: readonly ProjectGroup[]
  onMoveWorktreeToStatus: (worktreeId: string, status: WorkspaceStatus) => void
  onMoveWorktreesToStatus: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onPinWorktree: (worktreeId: string) => void
  onPinWorktrees: (worktreeIds: readonly string[]) => void
  onDropWorktreesOnWorkspaceBoard: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
    groups: readonly WorktreeDragGroup[]
  }) => void
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
  showInlineAgentCards: boolean
  showSectionStatus: boolean
  sectionActivityByGroupKey: ReadonlyMap<string, WorktreeSectionActivitySummary>
  // Why: broad grouping changes still remount the viewport, while add/delete
  // stays mounted for row-key anchoring and layout animation. These refs bridge
  // both paths so the virtualizer never falls back to scrollTop 0.
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
}

type WorktreeItemRow = Extract<Row, { type: 'item' }>

function formatSectionActivityLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

function SectionMetricsBadge({
  count,
  summary,
  showStatus
}: {
  count: number
  summary: WorktreeSectionActivitySummary
  showStatus: boolean
}): React.JSX.Element {
  const runningCount = showStatus ? summary.runningCount : 0
  const hasRunning = runningCount > 0
  const totalLabel = formatSectionActivityLabel(count, 'workspace')
  const runningLabel = hasRunning
    ? formatSectionActivityLabel(runningCount, 'running workspace')
    : 'no running workspaces'
  const badgeLabel = showStatus ? `${totalLabel}; ${runningLabel}` : totalLabel
  const totalTooltipLabel = showStatus && !hasRunning ? badgeLabel : totalLabel

  return (
    <span
      className="inline-flex h-4 shrink-0 overflow-hidden rounded-full border border-sidebar-border bg-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90"
      aria-label={badgeLabel}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-full min-w-4 items-center justify-center px-1.5">
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {totalTooltipLabel}
        </TooltipContent>
      </Tooltip>
      {showStatus && hasRunning ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex h-full min-w-4 items-center justify-center gap-1 border-l border-sidebar-border/80 bg-amber-500/10 px-1.5 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <span
                className="block size-1.5 rounded-full bg-amber-500 animate-pulse"
                aria-hidden="true"
              />
              <span>{runningCount}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {runningLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

type WorktreeRowDragState = {
  draggingWorktreeId: string | null
  sourceGroupKey: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
  pointerY: number | null
}

const EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS: ReadonlyMap<string, number> = new Map()

const WORKTREE_ROW_DRAG_INITIAL_STATE: WorktreeRowDragState = {
  draggingWorktreeId: null,
  sourceGroupKey: null,
  dropIndex: null,
  dropIndicatorY: null,
  previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  pointerY: null
}

type WorktreePointerDrag = {
  pointerId: number
  sourceRow: HTMLElement
  startX: number
  startY: number
  currentX: number
  currentY: number
  worktreeId: string
  draggedIds: readonly string[]
  reorderDraggedIds: readonly string[]
  reorderUnitDraggedIds: readonly string[]
  sourceGroupKey: string
  rects: readonly WorktreeSidebarDragRect[]
  active: boolean
  preview: HTMLElement | null
  previewOffsetX: number
  previewOffsetY: number
  frameId: number | null
}

type WorktreeDropPreview = {
  dropIndex: number
  dropIndicatorY: number
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
}

function areWorktreeDragPreviewOffsetsEqual(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false
    }
  }
  return true
}

function getWorktreeVirtualRowTransform(start: number, previewOffset: number): string {
  const base = getVirtualRowTransform(start)
  return previewOffset === 0 ? base : `${base} translateY(${previewOffset}px)`
}

function getPointerDropStatusTarget(args: { container: HTMLElement; x: number; y: number }): {
  status: WorkspaceStatus | null
  isPinDrop: boolean
} {
  const target = document.elementFromPoint(args.x, args.y)
  if (!(target instanceof Element) || !args.container.contains(target)) {
    return { status: null, isPinDrop: false }
  }
  const pinTarget = target.closest<HTMLElement>('[data-workspace-pin-drop-target]')
  if (pinTarget && args.container.contains(pinTarget)) {
    return { status: null, isPinDrop: true }
  }
  const statusTarget = target.closest<HTMLElement>('[data-workspace-status-drop-target]')
  return {
    status:
      statusTarget && args.container.contains(statusTarget)
        ? ((statusTarget.dataset.workspaceStatus as WorkspaceStatus | undefined) ?? null)
        : null,
    isPinDrop: false
  }
}

function isWorktreeItemRow(row: Row): row is WorktreeItemRow {
  return row.type === 'item'
}

export function renderRowContainsWorktree(row: RenderRow, worktreeId: string | null): boolean {
  if (worktreeId === null) {
    return false
  }
  if (row.type === 'lineage-group') {
    return row.rows.some((item) => item.worktree.id === worktreeId)
  }
  return row.type === 'item' && row.worktree.id === worktreeId
}

function buildRenderableRows(rows: Row[]): RenderRow[] {
  const renderRows: RenderRow[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (
      !isWorktreeItemRow(row) ||
      row.lineageChildCount === 0 ||
      row.lineageCollapsed ||
      rows[index + 1]?.type !== 'item' ||
      (rows[index + 1] as WorktreeItemRow).depth <= row.depth
    ) {
      renderRows.push(row)
      continue
    }

    const groupRows: WorktreeItemRow[] = [row]
    let cursor = index + 1
    while (cursor < rows.length) {
      const child = rows[cursor]
      if (!isWorktreeItemRow(child) || child.depth <= row.depth) {
        break
      }
      groupRows.push(child)
      cursor++
    }
    renderRows.push({
      type: 'lineage-group',
      key: getLineageGroupKey(row.worktree.id),
      rows: groupRows
    })
    index = cursor - 1
  }
  return renderRows
}

export function getRenderRowKey(row: RenderRow): string {
  if (row.type === 'header') {
    return `hdr:${row.key}`
  }
  if (row.type === 'lineage-group') {
    return `lineage-group:${row.key}`
  }
  if (row.type === 'imported-worktrees-card') {
    return `imported:${row.key}`
  }
  return `wt:${row.worktree.id}`
}

export function getWorktreeDragGroups(rows: Row[]): WorktreeDragGroup[] {
  const groups: WorktreeDragGroup[] = []
  let current: { key: string; ids: string[] } | null = null

  for (const row of rows) {
    if (row.type === 'header') {
      current = { key: row.key, ids: [] }
      groups.push({ key: current.key, worktreeIds: current.ids })
      continue
    }
    if (row.type === 'imported-worktrees-card') {
      continue
    }
    if (!current) {
      current = { key: ALL_GROUP_KEY, ids: [] }
      groups.push({ key: current.key, worktreeIds: current.ids })
    }
    current.ids.push(row.worktree.id)
  }

  return groups.filter((group) => group.worktreeIds.length > 0)
}

export function canKeepImportedWorktreesHidden(
  row: Extract<Row, { type: 'imported-worktrees-card' }>,
  actionState: ImportedWorktreeCardActionState | undefined
): boolean {
  return row.placement === 'repo-group' && actionState?.forceVisible !== true
}

function getWorktreeDragIndexes(groups: readonly WorktreeDragGroup[]): {
  groupKeyByWorktreeId: Map<string, string>
  groupIndexByWorktreeId: Map<string, number>
} {
  const groupKeyByWorktreeId = new Map<string, string>()
  const groupIndexByWorktreeId = new Map<string, number>()
  for (const group of groups) {
    group.worktreeIds.forEach((worktreeId, index) => {
      groupKeyByWorktreeId.set(worktreeId, group.key)
      groupIndexByWorktreeId.set(worktreeId, index)
    })
  }
  return { groupKeyByWorktreeId, groupIndexByWorktreeId }
}

function getVirtualRowIndex(element: Element): number | null {
  const index = parseInt(element.getAttribute('data-index') ?? '', 10)
  return Number.isNaN(index) ? null : index
}

function getVirtualRowKey(element: Element): string | null {
  return element.getAttribute('data-worktree-virtual-row-key')
}

const VirtualizedWorktreeViewport = React.memo(function VirtualizedWorktreeViewport({
  rows,
  activeWorktreeId,
  currentWorktreeId,
  groupBy,
  projectGroupOrdering,
  toggleGroup,
  collapsedGroups,
  handleCreateForRepo,
  handleOpenRepoSettings,
  handleOpenWorktreeVisibility,
  handleShowImportedWorktrees,
  handleKeepImportedWorktreesHidden,
  importedWorktreeCardActionState,
  handleRemoveProject,
  handleCreateGroupFromRepo,
  handleMoveProjectToGroup,
  handleRemoveProjectFromGroup,
  handleRenameProjectGroup,
  handleDeleteProjectGroup,
  activeModal,
  pendingRevealWorktree,
  clearPendingRevealWorktreeId,
  worktrees,
  selectedWorktreeIds,
  selectedWorktrees,
  onSelectionGesture,
  onContextMenuSelect,
  repoMap,
  worktreeMap,
  worktreeLineageById,
  repoOrder,
  allRepoIds,
  reorderRepos,
  prCache,
  workspaceStatuses,
  projectGroups = [],
  onMoveWorktreeToStatus,
  onMoveWorktreesToStatus,
  onPinWorktree,
  onPinWorktrees,
  onDropWorktreesOnWorkspaceBoard,
  shouldShowWorkspaceBoardDropIndicator,
  onReorderWorktrees,
  showInlineAgentCards,
  showSectionStatus,
  sectionActivityByGroupKey,
  scrollOffsetRef,
  scrollAnchorRef
}: VirtualizedWorktreeViewportProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const suppressMeasurementAdjustmentUntilRef = useRef(0)
  const directScrollInputUntilRef = useRef(0)
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)
  const [lineageReconnectWorktreeId, setLineageReconnectWorktreeId] = useState<string | null>(null)
  const [worktreeDragState, setWorktreeDragState] = useState<WorktreeRowDragState>(
    WORKTREE_ROW_DRAG_INITIAL_STATE
  )
  const [pendingRevealRetryTick, setPendingRevealRetryTick] = useState(0)
  const [documentVisibilityRevision, setDocumentVisibilityRevision] = useState(0)
  const [highlightedRevealWorktreeId, setHighlightedRevealWorktreeId] = useState<string | null>(
    null
  )
  const worktreeDragSessionRef = useRef<WorktreeSidebarDragSession | null>(null)
  const worktreePointerDragRef = useRef<WorktreePointerDrag | null>(null)
  const worktreePointerAutoscrollFrameIdRef = useRef<number | null>(null)
  const worktreePointerAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const worktreeNativeAutoscrollFrameIdRef = useRef<number | null>(null)
  const worktreeNativeAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const worktreeNativeLatestPointRef = useRef<WorktreeSidebarDragPoint | null>(null)
  const pendingRevealRetryRef = useRef<{ worktreeId: string; count: number } | null>(null)
  const revealHighlightTimeoutRef = useRef<number | null>(null)
  const flashRevealedWorktree = useCallback((worktreeId: string) => {
    if (revealHighlightTimeoutRef.current !== null) {
      window.clearTimeout(revealHighlightTimeoutRef.current)
    }
    // Why: remove before add restarts the CSS glow when the user repeatedly
    // asks to reveal the same active workspace.
    setHighlightedRevealWorktreeId(null)
    window.requestAnimationFrame(() => {
      setHighlightedRevealWorktreeId(worktreeId)
      revealHighlightTimeoutRef.current = window.setTimeout(() => {
        revealHighlightTimeoutRef.current = null
        setHighlightedRevealWorktreeId(null)
      }, 1500)
    })
  }, [])
  const suppressWorktreeClickUntilRef = useRef(0)
  const hasProjectGroups = projectGroups.length > 0
  const canReorderRepoHeaders =
    groupBy === 'repo' && projectGroupOrdering === 'manual' && !hasProjectGroups
  const lastVisibleRefreshKeyRef = useRef('')
  const reportVisibleGitHubPRRefreshCandidates = useAppStore(
    (s) => s.reportVisibleGitHubPRRefreshCandidates
  )
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const keybindings = useAppStore((s) => s.keybindings)
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const prVisibleRefreshGeneration = useAppStore((s) => s.prVisibleRefreshGeneration)
  const settings = useAppStore((s) => s.settings)

  useEffect(
    () =>
      installWorktreeVisibleRefreshVisibilityListener(() => {
        if (document.visibilityState !== 'visible') {
          // Why: the visible row identity can be unchanged after returning
          // from a hidden window; reset the key so visible PR/CI rows catch up.
          lastVisibleRefreshKeyRef.current = '__document_hidden__'
          return
        }
        setDocumentVisibilityRevision((revision) => revision + 1)
      }),
    []
  )

  // Drag is only meaningful when repo headers are using manual order. The
  // controller is still constructed for hook order stability when inert.
  const repoDrag = useRepoHeaderDrag({
    orderedRepoIds: allRepoIds,
    onCommit: reorderRepos,
    getScrollContainer: () => scrollRef.current
  })
  const worktreeDragGroups = useMemo(() => getWorktreeDragGroups(rows), [rows])
  const worktreeDragUnitGroups = useMemo(() => getWorktreeDragUnitGroups(rows), [rows])
  const worktreeLineageDragRows = useMemo(
    () =>
      rows
        .filter((row): row is WorktreeItemRow => row.type === 'item')
        .map((row) => ({ worktreeId: row.worktree.id, depth: row.depth })),
    [rows]
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
  const { groupKeyByWorktreeId, groupIndexByWorktreeId } = useMemo(
    () => getWorktreeDragIndexes(worktreeDragUnitGroups),
    [worktreeDragUnitGroups]
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
  const computeWorktreeDrop = useCallback(
    (pointerY: number): WorktreeDropPreview | null => {
      const session = worktreeDragSessionRef.current
      const container = scrollRef.current
      if (!session || !container) {
        return null
      }

      const containerRect = container.getBoundingClientRect()
      const localY = pointerY - containerRect.top + container.scrollTop
      const rects = session.rects
      if (rects.length === 0) {
        return null
      }
      const sourceGroup = worktreeDragUnitGroups.find(
        (group) => group.key === session.sourceGroupKey
      )
      if (!sourceGroup) {
        return null
      }

      const first = rects[0]!
      const last = rects.at(-1)!
      const boundaryDrop = getWorktreeSidebarBoundaryDrop({
        localY,
        firstRect: first,
        lastRect: last,
        sourceGroupSize: sourceGroup.worktreeIds.length
      })
      if (boundaryDrop.kind === 'outside') {
        return null
      }

      let dropIndex = last.groupIndex + 1
      let indicatorY = last.bottom + 3
      if (boundaryDrop.kind === 'drop') {
        dropIndex = boundaryDrop.dropIndex
        indicatorY = boundaryDrop.indicatorY
      } else {
        for (const rect of rects) {
          const mid = (rect.top + rect.bottom) / 2
          if (localY < mid) {
            dropIndex = rect.groupIndex
            indicatorY = Math.max(0, rect.top - 3)
            break
          }
        }
      }
      const previewOffsetsByWorktreeId = buildWorktreeDragPreviewOffsets({
        groupIds: sourceGroup.worktreeIds,
        draggedIds: session.reorderUnitDraggedIds,
        dropIndex,
        rects
      })
      return { dropIndex, dropIndicatorY: indicatorY, previewOffsetsByWorktreeId }
    },
    [worktreeDragUnitGroups]
  )
  const renderRows = useMemo(() => buildRenderableRows(rows), [rows])
  const firstHeaderIndex = useMemo(
    () => renderRows.findIndex((row) => row.type === 'header'),
    [renderRows]
  )
  const firstHeaderIndexRef = useRef(firstHeaderIndex)
  firstHeaderIndexRef.current = firstHeaderIndex
  const stickyHeaderIndexes = useMemo(() => getStickyHeaderIndexes(renderRows), [renderRows])
  const stickyHeaderIndexesRef = useRef(stickyHeaderIndexes)
  stickyHeaderIndexesRef.current = stickyHeaderIndexes
  const activeStickyHeaderIndexRef = useRef<number | null>(null)
  const stickyRangeStartIndexRef = useRef(0)
  const activeWorktreeRowIndex = useMemo(
    () => renderRows.findIndex((row) => renderRowContainsWorktree(row, activeWorktreeId)),
    [renderRows, activeWorktreeId]
  )
  const activeLineageChildRow = useMemo(() => {
    if (activeWorktreeId === null) {
      return null
    }
    for (const row of renderRows) {
      if (row.type !== 'lineage-group') {
        continue
      }
      const child = row.rows.slice(1).find((item) => item.worktree.id === activeWorktreeId)
      if (child) {
        return child
      }
    }
    return null
  }, [activeWorktreeId, renderRows])
  const activeLineageChildWorktreeId = activeLineageChildRow?.worktree.id ?? null
  const activeLineageChildConnectionId = activeLineageChildRow?.repo?.connectionId ?? null
  const activeLineageChildSshStatus = useAppStore((s) =>
    activeLineageChildConnectionId
      ? (s.sshConnectionStates.get(activeLineageChildConnectionId)?.status ?? 'disconnected')
      : null
  )
  const activeLineageChildTargetLabel = useAppStore((s) =>
    activeLineageChildConnectionId ? s.sshTargetLabels.get(activeLineageChildConnectionId) : null
  )
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const activeLineageChildSshDisconnected =
    activeLineageChildSshStatus !== null && activeLineageChildSshStatus !== 'connected'
  const renderRowsRef = useRef(renderRows)
  renderRowsRef.current = renderRows
  const getVirtualItemKey = useCallback(
    (index: number) => {
      const row = renderRows[index]
      if (!row) {
        return `__stale_${index}`
      }
      return getRenderRowKey(row)
    },
    [renderRows]
  )
  const getExpectedVirtualRowKey = useCallback((element: Element) => {
    const index = getVirtualRowIndex(element)
    const row = index === null ? undefined : renderRowsRef.current[index]
    return row ? getRenderRowKey(row) : null
  }, [])
  const isCurrentVirtualRowElement = useCallback(
    (element: Element) => {
      const expectedKey = getExpectedVirtualRowKey(element)
      return (
        element.isConnected &&
        expectedKey !== null &&
        element.getAttribute('data-worktree-virtual-row-key') === expectedKey
      )
    },
    [getExpectedVirtualRowKey]
  )
  const measureCurrentVirtualRowElement = useCallback(
    (
      element: HTMLDivElement,
      entry: ResizeObserverEntry | undefined,
      instance: Parameters<typeof measureVirtualElementSize<HTMLDivElement>>[2]
    ) => {
      if (!isCurrentVirtualRowElement(element)) {
        const index = getVirtualRowIndex(element)
        const measured = instance.getVirtualItems().find((item) => item.index === index)
        // Why: TanStack's ResizeObserver can deliver a stale row after a
        // collapse/delete/remount. Returning the current item size makes that
        // observation a no-op instead of writing the stale element's height
        // into whichever row now owns the old data-index.
        return (
          measured?.size ??
          estimateRenderRowSize(
            renderRowsRef.current,
            index ?? -1,
            firstHeaderIndexRef.current,
            activeStickyHeaderIndexRef.current
          )
        )
      }
      const index = getVirtualRowIndex(element)
      if (index !== null && renderRowsRef.current[index]?.type === 'header') {
        return estimateRenderRowSize(
          renderRowsRef.current,
          index,
          firstHeaderIndexRef.current,
          activeStickyHeaderIndexRef.current
        )
      }
      return measureVirtualElementSize(element, entry, instance)
    },
    [isCurrentVirtualRowElement]
  )
  const markScrollMovement = useCallback(() => {
    suppressMeasurementAdjustmentUntilRef.current =
      window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
  }, [])
  const markDirectScrollInput = useCallback(() => {
    const suppressUntil = window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
    suppressMeasurementAdjustmentUntilRef.current = suppressUntil
    directScrollInputUntilRef.current = suppressUntil
  }, [])
  const hasDirectScrollInput = useCallback(
    () => window.performance.now() < directScrollInputUntilRef.current,
    []
  )
  // Why: programmatic scrolls should keep measurement correction quiet, but
  // only direct input should block anchor restoration retries.
  const shouldSkipScrollAnchorRestore = useCallback(
    () => window.performance.now() < directScrollInputUntilRef.current,
    []
  )

  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      estimateRenderRowSize(
        renderRows,
        index,
        firstHeaderIndex,
        activeStickyHeaderIndexRef.current
      ),
    measureElement: measureCurrentVirtualRowElement,
    rangeExtractor: useCallback((range: Range) => {
      stickyRangeStartIndexRef.current = range.startIndex
      const activeStickyHeaderIndex = getActiveStickyHeaderIndex(
        stickyHeaderIndexesRef.current,
        range.startIndex
      )
      if (activeStickyHeaderIndex === null) {
        return defaultRangeExtractor(range)
      }

      // Why: this mirrors TanStack Virtual's sticky example — the active
      // section header remains a real virtual row even after it scrolls out.
      const previousStickyHeaderIndex = getPreviousStickyHeaderIndex(
        stickyHeaderIndexesRef.current,
        activeStickyHeaderIndex
      )
      return Array.from(
        new Set([
          activeStickyHeaderIndex,
          ...(previousStickyHeaderIndex === null ? [] : [previousStickyHeaderIndex]),
          ...defaultRangeExtractor(range)
        ])
      ).sort((a, b) => a - b)
    }, []),
    overscan: 10,
    gap: 6,
    // Why: the active sticky group header is rendered inside the virtual list,
    // so TanStack's scroll math needs the same top inset as the exact DOM reveal.
    scrollPaddingStart: WORKTREE_SIDEBAR_REVEAL_TOP_INSET,
    isScrollingResetDelay: USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS,
    // Why: the sidebar rows are rich cards. Flushing their React render inside
    // TanStack's native scroll listener can make wheel input wait on card work;
    // overscan gives the async render enough runway to stay visually filled.
    useFlushSync: false,
    // Why: tells the virtualizer to start its internal scrollOffset at the
    // ref value rather than 0, so the first getVirtualItems() call after
    // remount picks the correct window of rows. The sibling useLayoutEffect
    // mirrors this onto the actual scrollElement.scrollTop so the DOM and
    // virtualizer stay aligned across remounts.
    initialOffset: () => scrollOffsetRef.current,
    getItemKey: getVirtualItemKey
  })
  // Why: rich worktree cards remeasure while the user wheels through them.
  // TanStack's default correction writes scrollTop in that path, which feels
  // like rubber-banding. Structural mutations still use our explicit anchor
  // restore after direct scroll input has settled.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) =>
    shouldAdjustWorktreeSidebarMeasuredRowScroll({
      isScrolling: instance.isScrolling,
      now: window.performance.now(),
      suppressUntil: suppressMeasurementAdjustmentUntilRef.current
    })

  useEffect(() => {
    const handleSuppress = () => {
      // Why: compact agent expansion changes measured row height; let the row
      // grow in place instead of letting TanStack compensate scrollTop.
      suppressMeasurementAdjustmentUntilRef.current =
        window.performance.now() + EXPANDING_CARD_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
    }
    window.addEventListener(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT, handleSuppress)
    return () => {
      window.removeEventListener(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT, handleSuppress)
    }
  }, [])

  React.useEffect(() => {
    if (!pendingRevealWorktree) {
      return
    }

    {
      const targetWorktree = worktrees.find((w) => w.id === pendingRevealWorktree.worktreeId)
      if (targetWorktree && !targetWorktree.isPinned) {
        const seen = new Set<string>()
        let current: Worktree | undefined = targetWorktree
        while (current && !seen.has(current.id)) {
          seen.add(current.id)
          const lineage = worktreeLineageById[current.id]
          const parent = lineage ? worktreeMap.get(lineage.parentWorktreeId) : undefined
          if (
            !lineage ||
            !parent ||
            current.instanceId !== lineage.worktreeInstanceId ||
            parent.instanceId !== lineage.parentWorktreeInstanceId
          ) {
            break
          }
          const lineageGroupKey = getLineageGroupKey(parent.id)
          if (collapsedGroups.has(lineageGroupKey)) {
            toggleGroup(lineageGroupKey)
          }
          current = parent
        }
      }

      if (targetWorktree?.isPinned) {
        // Why: pinned worktrees live in the dedicated "Pinned" section regardless
        // of their PR-status / project group. Only uncollapse the Pinned header
        // itself — expanding the underlying status group would be surprising since
        // the user intentionally collapsed it.
        if (collapsedGroups.has(PINNED_GROUP_KEY)) {
          toggleGroup(PINNED_GROUP_KEY)
        }
      } else if (targetWorktree) {
        const groupKeys = getGroupKeysForWorktree(
          groupBy,
          targetWorktree,
          repoMap,
          prCache,
          workspaceStatuses,
          settings,
          projectGroups
        )
        for (const groupKey of groupKeys) {
          if (collapsedGroups.has(groupKey)) {
            toggleGroup(groupKey)
          }
        }
      }
    }

    requestAnimationFrame(() => {
      const targetWorktreeStillExists = worktrees.some(
        (worktree) => worktree.id === pendingRevealWorktree.worktreeId
      )
      const targetIndex = renderRows.findIndex((row) =>
        renderRowContainsWorktree(row, pendingRevealWorktree.worktreeId)
      )
      const outcome = resolvePendingSidebarReveal({ targetIndex, targetWorktreeStillExists })
      if (outcome === 'scroll-and-clear') {
        const targetRow = renderRows[targetIndex]
        const container = scrollRef.current
        const retryExactRevealOnNextFrame = () => {
          const previousRetry = pendingRevealRetryRef.current
          const nextRetryCount =
            previousRetry?.worktreeId === pendingRevealWorktree.worktreeId
              ? previousRetry.count + 1
              : 1
          pendingRevealRetryRef.current = {
            worktreeId: pendingRevealWorktree.worktreeId,
            count: nextRetryCount
          }
          if (nextRetryCount <= 8) {
            requestAnimationFrame(() => setPendingRevealRetryTick((tick) => tick + 1))
          } else {
            pendingRevealRetryRef.current = null
            clearPendingRevealWorktreeId()
          }
        }
        if (
          container &&
          revealMountedWorktreeElement(
            container,
            pendingRevealWorktree.worktreeId,
            pendingRevealWorktree.behavior
          )
        ) {
          if (pendingRevealWorktree.highlight) {
            flashRevealedWorktree(pendingRevealWorktree.worktreeId)
          }
          pendingRevealRetryRef.current = null
          clearPendingRevealWorktreeId()
          return
        }

        if (targetRow?.type !== 'lineage-group') {
          // Why: virtual row indexing can leave the card edge slightly clipped;
          // stage it into the mounted window, then retry the exact DOM reveal.
          virtualizer.scrollToIndex(targetIndex, {
            align: 'auto',
            behavior: 'auto'
          })
          retryExactRevealOnNextFrame()
          return
        }

        // Why: for grouped lineage rows the virtual row is only a staging
        // target. Jump it into the mounted window first, then retry the exact
        // card reveal instead of clearing while a smooth virtual scroll is
        // still in flight.
        virtualizer.scrollToIndex(targetIndex, {
          align: 'auto',
          behavior: 'auto'
        })
        retryExactRevealOnNextFrame()
        return
      }
      if (outcome === 'clear') {
        pendingRevealRetryRef.current = null
        clearPendingRevealWorktreeId()
      }
    })
  }, [
    pendingRevealWorktree,
    groupBy,
    worktrees,
    repoMap,
    prCache,
    worktreeLineageById,
    worktreeMap,
    renderRows,
    virtualizer,
    clearPendingRevealWorktreeId,
    toggleGroup,
    collapsedGroups,
    workspaceStatuses,
    settings,
    projectGroups,
    pendingRevealRetryTick,
    flashRevealedWorktree
  ])

  const prCacheLen = useAppStore((s) => countRecordKeysByReference(s.prCache))
  const issueCacheLen = useAppStore((s) => countRecordKeysByReference(s.issueCache))
  const renderRowKeySignature = useMemo(
    () => renderRows.map(getRenderRowKey).join('\n'),
    [renderRows]
  )
  const totalSize = virtualizer.getTotalSize()
  const virtualItems = virtualizer.getVirtualItems()
  const activeStickyHeaderIndex = getActiveStickyHeaderIndexForScroll({
    rangeStartIndex: stickyRangeStartIndexRef.current,
    scrollOffset: virtualizer.scrollOffset ?? scrollOffsetRef.current,
    stickyHeaderIndexes,
    virtualItems
  })
  activeStickyHeaderIndexRef.current = activeStickyHeaderIndex

  const measureMountedRows = useCallback(() => {
    virtualizer.elementsCache.forEach((element) => {
      if (!isCurrentVirtualRowElement(element)) {
        return
      }
      virtualizer.measureElement(element)
    })
  }, [isCurrentVirtualRowElement, virtualizer])
  const measureVirtualRowElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        virtualizer.measureElement(null)
        return
      }
      if (!isCurrentVirtualRowElement(element)) {
        return
      }
      virtualizer.measureElement(element)
    },
    [isCurrentVirtualRowElement, virtualizer]
  )

  useLayoutEffect(() => {
    // Why: after delete/collapse, TanStack may briefly retain the removed row's
    // cached element. Measuring that disconnected node reports 0px and corrupts
    // the next row's slot, so measure only elements whose DOM key still matches
    // the row currently rendered at that index.
    measureMountedRows()
    const frameId = window.requestAnimationFrame(measureMountedRows)
    return () => window.cancelAnimationFrame(frameId)
  }, [prCacheLen, issueCacheLen, measureMountedRows, renderRowKeySignature])

  useVirtualizedScrollAnchor({
    anchorRef: scrollAnchorRef,
    getItemElementKey: getVirtualRowKey,
    getRowKey: getRenderRowKey,
    itemElementSelector: '[data-worktree-virtual-row]',
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

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down') => {
      // Why: derive the cycling order from an all-expanded layout, not the
      // rendered rows. Otherwise Cmd+Shift+Up/Down would skip any worktree
      // hidden in a collapsed group — in particular it couldn't cross the
      // Pinned/All boundary when either section is collapsed. Reveal will
      // uncollapse the target section (see pendingRevealWorktree effect).
      const worktreeRows = buildRows(
        groupBy,
        worktrees,
        repoMap,
        prCache,
        new Set<string>(),
        repoOrder,
        workspaceStatuses,
        projectGroupOrdering,
        worktreeLineageById,
        worktreeMap,
        true,
        settings,
        projectGroups
      ).filter((r): r is Extract<Row, { type: 'item' }> => r.type === 'item')
      if (worktreeRows.length === 0) {
        return
      }

      let nextIndex = 0
      const currentIndex = worktreeRows.findIndex((r) => r.worktree.id === activeWorktreeId)

      if (currentIndex !== -1) {
        if (direction === 'up') {
          nextIndex = currentIndex - 1
          if (nextIndex < 0) {
            nextIndex = worktreeRows.length - 1
          }
        } else {
          nextIndex = currentIndex + 1
          if (nextIndex >= worktreeRows.length) {
            nextIndex = 0
          }
        }
      }

      const nextWorktreeId = worktreeRows[nextIndex].worktree.id
      // Why: keyboard cycling between worktrees is still real navigation, so
      // it must flow through the same activation helper that records history.
      activateAndRevealWorktree(nextWorktreeId)

      const rowIndex = renderRows.findIndex((row) => renderRowContainsWorktree(row, nextWorktreeId))
      if (rowIndex !== -1) {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
      }
    },
    [
      renderRows,
      activeWorktreeId,
      virtualizer,
      groupBy,
      projectGroupOrdering,
      worktrees,
      repoMap,
      prCache,
      repoOrder,
      workspaceStatuses,
      worktreeLineageById,
      worktreeMap,
      settings,
      projectGroups
    ]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeModal !== 'none' || isEditableTarget(e.target)) {
        return
      }

      const platform = getShortcutPlatform()
      if (keybindingMatchesAction('sidebar.focusWorktreeList', e, platform, keybindings)) {
        scrollRef.current?.focus()
        e.preventDefault()
        return
      }

      const direction = keybindingMatchesAction('worktree.navigateUp', e, platform, keybindings)
        ? 'up'
        : keybindingMatchesAction('worktree.navigateDown', e, platform, keybindings)
          ? 'down'
          : null
      if (direction) {
        markDirectScrollInput()
        navigateWorktree(direction)
        e.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [activeModal, keybindings, markDirectScrollInput, navigateWorktree])

  // Why: lightweight nested cards do not mount WorktreeCard, so the viewport
  // owns the SSH reconnect prompt for an active lineage child.
  useEffect(() => {
    if (activeLineageChildWorktreeId && activeLineageChildSshDisconnected) {
      setLineageReconnectWorktreeId(activeLineageChildWorktreeId)
    }
  }, [activeLineageChildWorktreeId, activeLineageChildSshDisconnected])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (e.target !== e.currentTarget) {
          return
        }
        markDirectScrollInput()
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down')
        e.preventDefault()
      } else if (e.key === 'Enter') {
        const helper = document.querySelector(
          '.xterm-helper-textarea'
        ) as HTMLTextAreaElement | null
        if (helper) {
          helper.focus()
        }
        e.preventDefault()
      } else if (['PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        markDirectScrollInput()
      }
    },
    [markDirectScrollInput, navigateWorktree]
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

  useEffect(() => {
    return () => {
      if (revealHighlightTimeoutRef.current !== null) {
        window.clearTimeout(revealHighlightTimeoutRef.current)
      }
    }
  }, [])

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
  }, [cancelWorktreePointerAutoscroll])

  const clearWorktreeDrag = useCallback(() => {
    cleanupWorktreePointerDrag()
    cancelWorktreeNativeAutoscroll()
    worktreeDragSessionRef.current = null
    setWorktreeDragState(WORKTREE_ROW_DRAG_INITIAL_STATE)
  }, [cancelWorktreeNativeAutoscroll, cleanupWorktreePointerDrag])

  const setScrollRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null && scrollRef.current !== null) {
        // Why: sidebar drag previews and autoscroll frames are tied to the
        // scroll root surface; clear them before that DOM owner disappears.
        clearWorktreeDrag()
      }
      scrollRef.current = node
    },
    [clearWorktreeDrag]
  )

  const flushWorktreePointerDrag = useCallback(() => {
    const drag = worktreePointerDragRef.current
    if (!drag) {
      return
    }
    drag.frameId = null
    if (!drag.active || !drag.preview) {
      return
    }
    updateSidebarDragPreviewPosition({
      preview: drag.preview,
      pointerX: drag.currentX,
      pointerY: drag.currentY,
      offsetX: drag.previewOffsetX,
      offsetY: drag.previewOffsetY
    })
    if (!refreshWorktreeDragSession()) {
      clearWorktreeDrag()
      return
    }
    const boardTarget = updateWorkspaceKanbanSidebarDropTargetVisual({
      x: drag.currentX,
      y: drag.currentY,
      shouldShowDropIndicator: (target) =>
        Boolean(
          target.status && shouldShowWorkspaceBoardDropIndicator(drag.draggedIds, target.status)
        )
    })
    if (boardTarget.status || boardTarget.isPinDrop) {
      setDragOverStatus(null)
      setPinDragOver(false)
      setWorktreeDragState((prev) =>
        prev.dropIndex === null &&
        prev.dropIndicatorY === null &&
        prev.pointerY === drag.currentY &&
        prev.previewOffsetsByWorktreeId.size === 0
          ? prev
          : {
              ...prev,
              dropIndex: null,
              dropIndicatorY: null,
              previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
              pointerY: drag.currentY
            }
      )
      return
    }

    const drop = computeWorktreeDrop(drag.currentY)
    const sidebarContainer = scrollRef.current
    if (!drop) {
      const target = sidebarContainer
        ? getPointerDropStatusTarget({
            container: sidebarContainer,
            x: drag.currentX,
            y: drag.currentY
          })
        : { status: null, isPinDrop: false }
      setDragOverStatus(target.status)
      setPinDragOver(target.isPinDrop)
      setWorktreeDragState((prev) =>
        prev.dropIndex === null &&
        prev.dropIndicatorY === null &&
        prev.pointerY === drag.currentY &&
        prev.previewOffsetsByWorktreeId.size === 0
          ? prev
          : {
              ...prev,
              dropIndex: null,
              dropIndicatorY: null,
              previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
              pointerY: drag.currentY
            }
      )
      return
    }
    clearWorkspaceKanbanSidebarDropTargetVisual()
    setDragOverStatus(null)
    setPinDragOver(false)
    setWorktreeDragState((prev) =>
      prev.dropIndex === drop.dropIndex &&
      prev.dropIndicatorY === drop.dropIndicatorY &&
      prev.pointerY === drag.currentY &&
      areWorktreeDragPreviewOffsetsEqual(
        prev.previewOffsetsByWorktreeId,
        drop.previewOffsetsByWorktreeId
      )
        ? prev
        : { ...prev, ...drop, pointerY: drag.currentY }
    )
  }, [
    clearWorktreeDrag,
    computeWorktreeDrop,
    refreshWorktreeDragSession,
    shouldShowWorkspaceBoardDropIndicator
  ])

  const scheduleWorktreePointerDragFrame = useCallback(
    (drag: WorktreePointerDrag) => {
      if (drag.frameId !== null) {
        return
      }
      drag.frameId = window.requestAnimationFrame(flushWorktreePointerDrag)
    },
    [flushWorktreePointerDrag]
  )

  const runWorktreePointerAutoscrollFrame = useCallback(
    (frameTime: number) => {
      worktreePointerAutoscrollFrameIdRef.current = null
      const drag = worktreePointerDragRef.current
      const container = scrollRef.current
      const session = worktreeDragSessionRef.current
      if (!drag?.active || !container || !session) {
        cancelWorktreePointerAutoscroll()
        return
      }

      const previousFrameTime = worktreePointerAutoscrollLastFrameTimeRef.current ?? frameTime
      worktreePointerAutoscrollLastFrameTimeRef.current = frameTime
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point: { clientX: drag.currentX, clientY: drag.currentY },
        containerRect: container.getBoundingClientRect(),
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        elapsedMs: frameTime - previousFrameTime
      })
      if (autoscroll) {
        markScrollMovement()
        container.scrollTop = autoscroll.scrollTop
        if (!refreshWorktreeDragSession()) {
          clearWorktreeDrag()
          return
        }
        scheduleWorktreePointerDragFrame(drag)
      }

      worktreePointerAutoscrollFrameIdRef.current = window.requestAnimationFrame(
        runWorktreePointerAutoscrollFrame
      )
    },
    [
      cancelWorktreePointerAutoscroll,
      clearWorktreeDrag,
      markScrollMovement,
      refreshWorktreeDragSession,
      scheduleWorktreePointerDragFrame
    ]
  )

  const startWorktreePointerAutoscroll = useCallback(() => {
    if (worktreePointerAutoscrollFrameIdRef.current !== null) {
      return
    }
    worktreePointerAutoscrollLastFrameTimeRef.current = null
    worktreePointerAutoscrollFrameIdRef.current = window.requestAnimationFrame(
      runWorktreePointerAutoscrollFrame
    )
  }, [runWorktreePointerAutoscrollFrame])

  const beginWorktreePointerDrag = useCallback(
    (drag: WorktreePointerDrag) => {
      const { preview, offsetX, offsetY } = createSidebarDragPreview({
        sourceRow: drag.sourceRow,
        pointerX: drag.currentX,
        pointerY: drag.currentY,
        draggedCount: drag.draggedIds.length
      })
      drag.active = true
      drag.preview = preview
      drag.previewOffsetX = offsetX
      drag.previewOffsetY = offsetY
      suppressWorktreeClickUntilRef.current = window.performance.now() + 500
      setSidebarPointerDragDocumentStyles(true)
      worktreeDragSessionRef.current = {
        draggingWorktreeId: drag.worktreeId,
        sourceGroupKey: drag.sourceGroupKey,
        draggedIds: drag.draggedIds,
        reorderDraggedIds: drag.reorderDraggedIds,
        reorderUnitDraggedIds: drag.reorderUnitDraggedIds,
        rects: drag.rects
      }
      setWorktreeDragState({
        draggingWorktreeId: drag.worktreeId,
        sourceGroupKey: drag.sourceGroupKey,
        dropIndex: null,
        dropIndicatorY: null,
        previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
        pointerY: drag.currentY
      })
      startWorktreePointerAutoscroll()
      scheduleWorktreePointerDragFrame(drag)
    },
    [scheduleWorktreePointerDragFrame, startWorktreePointerAutoscroll]
  )

  const handleWorktreeRowPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, worktreeId: string) => {
      if (event.button !== 0 || event.pointerType === 'touch') {
        return
      }
      const sourceRow = event.currentTarget
      if (isSidebarPointerDragBlocked(event.target, sourceRow)) {
        return
      }
      const sourceGroupKey = groupKeyByWorktreeId.get(worktreeId)
      const container = scrollRef.current
      if (!sourceGroupKey || !container) {
        return
      }
      const rects = getWorktreeSidebarDragRectsForGroup(container, sourceGroupKey)
      if (rects.length <= 1 && !hasWorkspaceKanbanSidebarDropBoard()) {
        return
      }
      const draggedIds =
        selectedWorktreeIds.has(worktreeId) && selectedWorktrees.length > 1
          ? selectedWorktrees.map((worktree) => worktree.id)
          : [worktreeId]
      const reorderDraggedIds = getReorderDraggedIds(draggedIds)
      const reorderUnitDraggedIds = getReorderUnitDraggedIds(sourceGroupKey, reorderDraggedIds)
      worktreePointerDragRef.current = {
        pointerId: event.pointerId,
        sourceRow,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        worktreeId,
        draggedIds,
        reorderDraggedIds,
        reorderUnitDraggedIds,
        sourceGroupKey,
        rects,
        active: false,
        preview: null,
        previewOffsetX: 0,
        previewOffsetY: 0,
        frameId: null
      }
    },
    [
      getReorderDraggedIds,
      getReorderUnitDraggedIds,
      groupKeyByWorktreeId,
      selectedWorktreeIds,
      selectedWorktrees
    ]
  )

  const handleWorktreeRowClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (window.performance.now() >= suppressWorktreeClickUntilRef.current) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      drag.currentX = event.clientX
      drag.currentY = event.clientY
      if (!drag.active) {
        const distance = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY)
        if (distance < SIDEBAR_POINTER_DRAG_THRESHOLD_PX) {
          return
        }
        beginWorktreePointerDrag(drag)
      }
      event.preventDefault()
      event.stopPropagation()
      scheduleWorktreePointerDragFrame(drag)
    }

    const handlePointerUp = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      drag.currentX = event.clientX
      drag.currentY = event.clientY
      if (!drag.active) {
        worktreePointerDragRef.current = null
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const boardDropTarget = getWorkspaceKanbanSidebarDropTarget(event.clientX, event.clientY)
      if (boardDropTarget.isPinDrop) {
        onPinWorktrees(drag.draggedIds)
      } else if (boardDropTarget.status) {
        onDropWorktreesOnWorkspaceBoard({
          worktreeIds: drag.draggedIds,
          status: boardDropTarget.status,
          dropIndex: boardDropTarget.dropIndex,
          groups: getWorkspaceKanbanSidebarDropGroups()
        })
      } else {
        const drop = computeWorktreeDrop(event.clientY)
        if (drop) {
          onReorderWorktrees({
            groups: worktreeDragGroups,
            sourceGroupKey: drag.sourceGroupKey,
            draggedIds: drag.reorderDraggedIds,
            dropIndex: getFullDropIndexForWorktreeDragUnit({
              groups: worktreeDragUnitGroups,
              sourceGroupKey: drag.sourceGroupKey,
              dropIndex: drop.dropIndex
            })
          })
        } else if (scrollRef.current) {
          const container = scrollRef.current
          const target = getPointerDropStatusTarget({
            container,
            x: event.clientX,
            y: event.clientY
          })
          if (target.isPinDrop) {
            onPinWorktrees(drag.draggedIds)
          } else if (target.status) {
            onMoveWorktreesToStatus(drag.draggedIds, target.status)
          }
        }
      }
      clearWorktreeDrag()
    }

    const handlePointerCancel = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      clearWorktreeDrag()
    }

    window.addEventListener('pointermove', handlePointerMove, { capture: true })
    window.addEventListener('pointerup', handlePointerUp, { capture: true })
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true })
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, { capture: true })
      window.removeEventListener('pointerup', handlePointerUp, { capture: true })
      window.removeEventListener('pointercancel', handlePointerCancel, { capture: true })
    }
  }, [
    beginWorktreePointerDrag,
    clearWorktreeDrag,
    computeWorktreeDrop,
    onMoveWorktreesToStatus,
    onDropWorktreesOnWorkspaceBoard,
    onPinWorktrees,
    onReorderWorktrees,
    refreshWorktreeDragSession,
    scheduleWorktreePointerDragFrame,
    shouldShowWorkspaceBoardDropIndicator,
    worktreeDragGroups,
    worktreeDragUnitGroups
  ])

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

  const runWorktreeNativeAutoscrollFrame = useCallback(
    (frameTime: number) => {
      worktreeNativeAutoscrollFrameIdRef.current = null
      const point = worktreeNativeLatestPointRef.current
      const container = scrollRef.current
      const session = worktreeDragSessionRef.current
      if (!point || !container || !session) {
        cancelWorktreeNativeAutoscroll()
        return
      }

      const previousFrameTime = worktreeNativeAutoscrollLastFrameTimeRef.current ?? frameTime
      worktreeNativeAutoscrollLastFrameTimeRef.current = frameTime
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point,
        containerRect: container.getBoundingClientRect(),
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        elapsedMs: frameTime - previousFrameTime
      })
      if (autoscroll) {
        markScrollMovement()
        container.scrollTop = autoscroll.scrollTop
        if (!refreshWorktreeDragSession()) {
          clearWorktreeDrag()
          return
        }
        const drop = computeWorktreeDrop(point.clientY)
        if (!drop) {
          setWorktreeDragState((prev) =>
            prev.dropIndex === null &&
            prev.dropIndicatorY === null &&
            prev.previewOffsetsByWorktreeId.size === 0
              ? prev
              : {
                  ...prev,
                  dropIndex: null,
                  dropIndicatorY: null,
                  previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
                  pointerY: null
                }
          )
        } else {
          setWorktreeDragState((prev) =>
            prev.dropIndex === drop.dropIndex &&
            prev.dropIndicatorY === drop.dropIndicatorY &&
            areWorktreeDragPreviewOffsetsEqual(
              prev.previewOffsetsByWorktreeId,
              drop.previewOffsetsByWorktreeId
            )
              ? prev
              : { ...prev, ...drop, pointerY: point.clientY }
          )
        }
      }

      worktreeNativeAutoscrollFrameIdRef.current = window.requestAnimationFrame(
        runWorktreeNativeAutoscrollFrame
      )
    },
    [
      cancelWorktreeNativeAutoscroll,
      clearWorktreeDrag,
      computeWorktreeDrop,
      markScrollMovement,
      refreshWorktreeDragSession
    ]
  )

  const startWorktreeNativeAutoscroll = useCallback(() => {
    if (worktreeNativeAutoscrollFrameIdRef.current !== null) {
      return
    }
    worktreeNativeAutoscrollLastFrameTimeRef.current = null
    worktreeNativeAutoscrollFrameIdRef.current = window.requestAnimationFrame(
      runWorktreeNativeAutoscrollFrame
    )
  }, [runWorktreeNativeAutoscrollFrame])

  const handleWorktreeCardDragStart = useCallback(
    (
      _event: React.DragEvent<HTMLDivElement>,
      worktreeId: string,
      draggedIds: readonly string[]
    ) => {
      const sourceGroupKey = groupKeyByWorktreeId.get(worktreeId)
      if (!sourceGroupKey) {
        return
      }
      const reorderDraggedIds = getReorderDraggedIds(draggedIds)
      const reorderUnitDraggedIds = getReorderUnitDraggedIds(sourceGroupKey, reorderDraggedIds)
      worktreeDragSessionRef.current = {
        draggingWorktreeId: worktreeId,
        sourceGroupKey,
        draggedIds,
        reorderDraggedIds,
        reorderUnitDraggedIds,
        rects: scrollRef.current
          ? getWorktreeSidebarDragRectsForGroup(scrollRef.current, sourceGroupKey)
          : []
      }
      setWorktreeDragState({
        draggingWorktreeId: worktreeId,
        sourceGroupKey,
        dropIndex: null,
        dropIndicatorY: null,
        previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
        pointerY: null
      })
    },
    [getReorderDraggedIds, getReorderUnitDraggedIds, groupKeyByWorktreeId]
  )

  const handleWorktreeDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return
      }
      worktreeNativeLatestPointRef.current = { clientX: event.clientX, clientY: event.clientY }
      startWorktreeNativeAutoscroll()
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const drop = computeWorktreeDrop(event.clientY)
      if (!drop) {
        setWorktreeDragState((prev) =>
          prev.dropIndex === null &&
          prev.dropIndicatorY === null &&
          prev.previewOffsetsByWorktreeId.size === 0
            ? prev
            : {
                ...prev,
                dropIndex: null,
                dropIndicatorY: null,
                previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
                pointerY: null
              }
        )
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setWorktreeDragState((prev) =>
        prev.dropIndex === drop.dropIndex &&
        prev.dropIndicatorY === drop.dropIndicatorY &&
        areWorktreeDragPreviewOffsetsEqual(
          prev.previewOffsetsByWorktreeId,
          drop.previewOffsetsByWorktreeId
        )
          ? prev
          : { ...prev, ...drop, pointerY: event.clientY }
      )
    },
    [
      clearWorktreeDrag,
      computeWorktreeDrop,
      refreshWorktreeDragSession,
      startWorktreeNativeAutoscroll
    ]
  )

  const handleWorktreeDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return
      }
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const boardDropTarget = getWorkspaceKanbanSidebarDropTarget(event.clientX, event.clientY)
      if (boardDropTarget.status || boardDropTarget.isPinDrop) {
        clearWorktreeDrag()
        return
      }
      const drop = computeWorktreeDrop(event.clientY)
      if (!drop) {
        clearWorktreeDrag()
        return
      }
      event.preventDefault()
      onReorderWorktrees({
        groups: worktreeDragGroups,
        sourceGroupKey: session.sourceGroupKey,
        draggedIds: session.reorderDraggedIds,
        dropIndex: getFullDropIndexForWorktreeDragUnit({
          groups: worktreeDragUnitGroups,
          sourceGroupKey: session.sourceGroupKey,
          dropIndex: drop.dropIndex
        })
      })
      clearWorktreeDrag()
    },
    [
      clearWorktreeDrag,
      computeWorktreeDrop,
      onReorderWorktrees,
      refreshWorktreeDragSession,
      worktreeDragGroups,
      worktreeDragUnitGroups
    ]
  )

  useEffect(() => {
    if (document.visibilityState !== 'visible') {
      lastVisibleRefreshKeyRef.current = '__document_hidden__'
      return
    }
    if (groupBy !== 'pr-status' && !cardProps.includes('pr') && !cardProps.includes('ci')) {
      if (lastVisibleRefreshKeyRef.current !== '__hidden__') {
        lastVisibleRefreshKeyRef.current = '__hidden__'
        reportVisibleGitHubPRRefreshCandidates([], Date.now())
      }
      return
    }
    const scrollEl = scrollRef.current
    if (!scrollEl) {
      return
    }
    const viewportTop = scrollEl.scrollTop
    const viewportBottom = viewportTop + scrollEl.clientHeight
    const visibleRows = virtualItems
      .filter((item) => item.start < viewportBottom && item.end > viewportTop)
      .map((item) => renderRows[item.index])
      .filter((row): row is Extract<Row, { type: 'item' }> => row?.type === 'item')
      .filter((row) => row.repo?.kind === 'git' && !row.worktree.isBare && row.worktree.branch)
    const visibleWorktreeIds = visibleRows.map((row) => row.worktree.id)
    const visibleIdentity = visibleRows
      .map((row) => `${row.worktree.id}:${row.worktree.branch}:${row.worktree.linkedPR ?? ''}`)
      .join('|')
    const key = `${visibleIdentity}:${sshConnectedGeneration}:${prVisibleRefreshGeneration}:${cardProps.join(',')}`
    if (!key || key === lastVisibleRefreshKeyRef.current) {
      return
    }
    lastVisibleRefreshKeyRef.current = key
    reportVisibleGitHubPRRefreshCandidates(visibleWorktreeIds, Date.now())
  }, [
    cardProps,
    documentVisibilityRevision,
    groupBy,
    renderRows,
    reportVisibleGitHubPRRefreshCandidates,
    prVisibleRefreshGeneration,
    sshConnectedGeneration,
    virtualItems
  ])

  const activeDescendantId =
    activeWorktreeId != null &&
    activeWorktreeRowIndex !== -1 &&
    virtualItems.some((item) => item.index === activeWorktreeRowIndex)
      ? getWorktreeOptionId(activeWorktreeId)
      : undefined

  const hasWorkspaceDropTargets = useMemo(
    () =>
      groupBy === 'workspace-status' ||
      rows.some((row) => row.type === 'header' && row.key === PINNED_GROUP_KEY),
    [groupBy, rows]
  )

  const handleWorkspaceStatusDragOver = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      if (!hasWorkspaceDragData(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverStatus(status)
    },
    []
  )

  const handleWorkspaceStatusDragLeave = useCallback((event: React.DragEvent) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setDragOverStatus(null)
  }, [])

  const handleWorkspacePinDragOver = useCallback((event: React.DragEvent) => {
    if (!hasWorkspaceDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setPinDragOver(true)
  }, [])

  const handleWorkspacePinDragLeave = useCallback((event: React.DragEvent) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setPinDragOver(false)
  }, [])

  const handleWorkspaceStatusDragFinish = useCallback(() => {
    setDragOverStatus(null)
    setPinDragOver(false)
  }, [])

  const handleWorkspaceStatusDrop = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      const worktreeIds = readWorkspaceDragDataIds(event.dataTransfer)
      if (worktreeIds.length === 0) {
        return
      }
      event.preventDefault()
      setDragOverStatus(null)
      onMoveWorktreesToStatus(worktreeIds, status)
    },
    [onMoveWorktreesToStatus]
  )

  useEffect(() => {
    const handleDocumentDrop = (event: DragEvent): void => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return
      }
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const drop = computeWorktreeDrop(event.clientY)
      if (!drop) {
        clearWorktreeDrag()
        return
      }
      // Why: status-group drops are captured before React sees them. When the
      // pointer is still inside the source group, this is a reorder rather than
      // a status move, so commit here and stop the status-drop capture handler.
      event.preventDefault()
      event.stopPropagation()
      onReorderWorktrees({
        groups: worktreeDragGroups,
        sourceGroupKey: session.sourceGroupKey,
        draggedIds: session.reorderDraggedIds,
        dropIndex: getFullDropIndexForWorktreeDragUnit({
          groups: worktreeDragUnitGroups,
          sourceGroupKey: session.sourceGroupKey,
          dropIndex: drop.dropIndex
        })
      })
      clearWorktreeDrag()
    }

    document.addEventListener('drop', handleDocumentDrop, true)
    return () => document.removeEventListener('drop', handleDocumentDrop, true)
  }, [
    clearWorktreeDrag,
    computeWorktreeDrop,
    onReorderWorktrees,
    refreshWorktreeDragSession,
    worktreeDragGroups,
    worktreeDragUnitGroups
  ])

  useEffect(() => {
    const handleDocumentDragEnd = (): void => {
      if (worktreeDragSessionRef.current) {
        clearWorktreeDrag()
      }
    }

    document.addEventListener('dragend', handleDocumentDragEnd, true)
    return () => document.removeEventListener('dragend', handleDocumentDragEnd, true)
  }, [clearWorktreeDrag])

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible' && worktreeDragSessionRef.current) {
        clearWorktreeDrag()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [clearWorktreeDrag])

  useWorkspaceStatusDocumentDrop(
    scrollRef,
    onMoveWorktreeToStatus,
    onPinWorktree,
    handleWorkspaceStatusDragFinish,
    hasWorkspaceDropTargets,
    {
      onMoveWorktreesToStatus,
      onPinWorktrees
    }
  )

  return (
    <div data-worktree-sidebar-container className="relative min-h-0 flex-1">
      <div
        ref={setScrollRootRef}
        data-worktree-sidebar
        tabIndex={0}
        role="listbox"
        aria-label="Worktrees"
        aria-orientation="vertical"
        aria-multiselectable="true"
        aria-activedescendant={activeDescendantId}
        onKeyDown={handleContainerKeyDown}
        // Why: trackpad momentum can continue as sparse scroll events after the
        // original wheel/touch event stream quiets down. Keep measurement-based
        // scroll correction suppressed until the viewport itself has stopped.
        onScroll={handleScroll}
        onPointerDown={handleScrollPointerDown}
        onTouchMove={markDirectScrollInput}
        onWheel={markDirectScrollInput}
        onDragOver={handleWorktreeDragOver}
        onDrop={handleWorktreeDrop}
        className="worktree-sidebar-scrollbar h-full overflow-y-scroll overflow-x-hidden pl-1 scrollbar-sleek outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset pt-px"
        style={WORKTREE_SIDEBAR_SCROLL_STYLE}
      >
        {activeLineageChildConnectionId && activeLineageChildSshStatus ? (
          <SshDisconnectedDialog
            open={
              lineageReconnectWorktreeId === activeLineageChildWorktreeId &&
              activeLineageChildSshDisconnected
            }
            onOpenChange={(open) => {
              if (!open) {
                setLineageReconnectWorktreeId(null)
              }
            }}
            targetId={activeLineageChildConnectionId}
            targetLabel={
              activeLineageChildTargetLabel ?? activeLineageChildRow?.repo?.displayName ?? ''
            }
            status={activeLineageChildSshStatus}
          />
        ) : null}
        <div
          role="presentation"
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {canReorderRepoHeaders &&
          repoDrag.state.draggingRepoId !== null &&
          repoDrag.state.dropIndicatorY !== null ? (
            <div
              role="presentation"
              className="pointer-events-none absolute left-2 right-2 z-10 border-t border-dashed border-muted-foreground/70"
              style={{ top: `${repoDrag.state.dropIndicatorY}px` }}
            />
          ) : null}
          {worktreeDragState.draggingWorktreeId !== null &&
          worktreeDragState.dropIndicatorY !== null ? (
            <div
              role="presentation"
              className="pointer-events-none absolute left-3 right-2 z-30 flex h-3 -translate-y-1/2 items-center"
              style={{ top: `${worktreeDragState.dropIndicatorY}px` }}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-sidebar-ring shadow-[0_0_0_2px_var(--sidebar)]" />
              <span className="h-0.5 flex-1 rounded-full bg-sidebar-ring shadow-[0_0_0_2px_var(--sidebar)]" />
              <span className="size-1.5 shrink-0 rounded-full bg-sidebar-ring shadow-[0_0_0_2px_var(--sidebar)]" />
            </div>
          ) : null}
          {virtualItems.map((vItem) => {
            const row = renderRows[vItem.index]
            if (!row) {
              return null
            }

            if (row.type === 'header') {
              const isActiveStickyHeader = activeStickyHeaderIndexRef.current === vItem.index
              const hasHeaderTopSpacing = shouldUseHeaderTopSpacing({
                rows: renderRows,
                index: vItem.index,
                firstHeaderIndex
              })
              const isRepoHeader = groupBy === 'repo' && row.repo !== undefined
              const isProjectGroupHeader = groupBy === 'repo' && row.projectGroup !== undefined
              const projectIdForHeader = isRepoHeader ? row.repo!.id : undefined
              const isDraggingThis =
                canReorderRepoHeaders &&
                repoDrag.state.draggingRepoId !== null &&
                repoDrag.state.draggingRepoId === projectIdForHeader
              const headerWorkspaceStatus =
                groupBy === 'workspace-status'
                  ? getWorkspaceStatusFromGroupKey(row.key, workspaceStatuses)
                  : null
              const isPinnedHeader = row.key === PINNED_GROUP_KEY
              const repoHeaderColor = resolveProjectGroupHeaderColor({
                groupBy,
                headerKey: row.key,
                badgeColor: row.repo?.badgeColor
              })
              const createState = row.repo
                ? getRepoHeaderCreateState({
                    repo: row.repo,
                    label: row.label,
                    sshStatus: row.repo.connectionId
                      ? (sshConnectionStates.get(row.repo.connectionId)?.status ?? null)
                      : null
                  })
                : null
              const projectGroupDepth = row.projectGroupDepth ?? 0
              const isCollapsed = collapsedGroups.has(row.key)
              const sectionActivity =
                sectionActivityByGroupKey.get(row.key) ?? EMPTY_WORKTREE_SECTION_ACTIVITY
              return (
                <div
                  key={vItem.key}
                  role="presentation"
                  data-worktree-virtual-row
                  data-worktree-virtual-row-key={String(vItem.key)}
                  data-worktree-sticky-header=""
                  data-worktree-sticky-header-active={isActiveStickyHeader ? '' : undefined}
                  data-index={vItem.index}
                  ref={measureVirtualRowElement}
                  className={cn(
                    'left-0 right-0',
                    // Why: the inter-group spacer only applies while the header
                    // scrolls in normally; the pinned header drops it to sit
                    // flush at the top. The swap fires when the header row
                    // reaches the top (see getActiveStickyHeaderIndexForScroll),
                    // so the previous repo no longer stays pinned over it.
                    hasHeaderTopSpacing && !isActiveStickyHeader && 'pt-2',
                    isActiveStickyHeader ? 'sticky -top-px z-20 bg-sidebar' : 'absolute top-0'
                  )}
                  style={
                    isActiveStickyHeader
                      ? undefined
                      : { transform: getVirtualRowTransform(vItem.start) }
                  }
                >
                  <div
                    role="button"
                    tabIndex={0}
                    data-repo-header-id={projectIdForHeader}
                    data-workspace-status-drop-target={headerWorkspaceStatus ? '' : undefined}
                    data-workspace-status={headerWorkspaceStatus ?? undefined}
                    data-workspace-pin-drop-target={isPinnedHeader ? '' : undefined}
                    className={cn(
                      'group flex h-7 w-full items-center gap-1.5 pr-1 text-left transition-all',
                      'cursor-pointer',
                      isDraggingThis &&
                        'bg-accent/80 ring-1 ring-ring/40 shadow-md rounded-md scale-[1.01]',
                      headerWorkspaceStatus &&
                        dragOverStatus === headerWorkspaceStatus &&
                        'rounded-md bg-sidebar-accent ring-1 ring-sidebar-ring/40',
                      isPinnedHeader &&
                        pinDragOver &&
                        'rounded-md bg-sidebar-accent ring-1 ring-sidebar-ring/40',
                      row.repo && 'overflow-hidden'
                    )}
                    style={{
                      paddingLeft: 12 + Math.min(projectGroupDepth, 6) * PROJECT_GROUP_HEADER_INDENT
                    }}
                    onDragOver={
                      isPinnedHeader
                        ? handleWorkspacePinDragOver
                        : headerWorkspaceStatus
                          ? (event) => handleWorkspaceStatusDragOver(event, headerWorkspaceStatus)
                          : undefined
                    }
                    onDragLeave={
                      isPinnedHeader
                        ? handleWorkspacePinDragLeave
                        : headerWorkspaceStatus
                          ? handleWorkspaceStatusDragLeave
                          : undefined
                    }
                    onDrop={
                      headerWorkspaceStatus
                        ? (event) => handleWorkspaceStatusDrop(event, headerWorkspaceStatus)
                        : undefined
                    }
                    onClick={() => toggleGroupWithScrollAnchor(row.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleGroupWithScrollAnchor(row.key)
                      }
                    }}
                  >
                    {row.icon ? (
                      <div
                        onPointerDown={
                          canReorderRepoHeaders && isRepoHeader && projectIdForHeader
                            ? (e) => repoDrag.onHandlePointerDown(e, projectIdForHeader)
                            : undefined
                        }
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                          repoHeaderColor ? 'text-muted-foreground' : row.tone
                        )}
                      >
                        {row.repo ? (
                          <RepoIconGlyph
                            repoIcon={row.repo.repoIcon}
                            color={repoHeaderColor}
                            className="size-4"
                            iconClassName="size-3.5"
                          />
                        ) : (
                          <row.icon className="size-3" />
                        )}
                      </div>
                    ) : null}

                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div className="min-w-0 truncate text-[13px] font-semibold leading-none">
                          {row.label}
                        </div>
                        <SectionMetricsBadge
                          count={row.count}
                          summary={sectionActivity}
                          showStatus={showSectionStatus}
                        />
                      </div>
                    </div>

                    <div className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100">
                      <ChevronDown
                        className={cn(
                          'size-3.5 cursor-pointer transition-transform [&_path]:cursor-pointer',
                          isCollapsed && '-rotate-90'
                        )}
                      />
                    </div>

                    {isProjectGroupHeader && !row.repo && row.projectGroup?.id ? (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="size-5 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                            aria-label={`Group actions for ${row.label}`}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={stopRepoHeaderKeyboardToggle}
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <Ellipsis className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          side="bottom"
                          sideOffset={6}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              if (row.projectGroup?.id) {
                                handleRenameProjectGroup(row.projectGroup.id, row.label)
                              }
                            }}
                          >
                            Rename group
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => {
                              if (row.projectGroup?.id) {
                                handleDeleteProjectGroup(row.projectGroup.id, row.label)
                              }
                            }}
                          >
                            Delete group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}

                    {row.repo && groupBy === 'repo' ? (
                      <DropdownMenu modal={false}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="size-5 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                                aria-label={`Project actions for ${row.label}`}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={stopRepoHeaderKeyboardToggle}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                <Ellipsis className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            Project actions
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent
                          align="end"
                          side="bottom"
                          sideOffset={6}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              if (row.repo) {
                                handleOpenRepoSettings(row.repo.id)
                              }
                            }}
                          >
                            <SlidersHorizontal className="size-3.5" />
                            Project Settings
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              if (row.repo) {
                                handleOpenRepoSettings(
                                  row.repo.id,
                                  getRepositoryIconSectionId(row.repo.id)
                                )
                              }
                            }}
                          >
                            <Shapes className="size-3.5" />
                            Change Project Icon
                          </DropdownMenuItem>
                          {row.repo && isGitRepoKind(row.repo) ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                if (row.repo) {
                                  handleOpenWorktreeVisibility(row.repo.id)
                                }
                              }}
                            >
                              <Eye className="size-3.5" />
                              {getWorktreeVisibilityMenuLabel(row.repo)}
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            onSelect={() => {
                              if (row.repo) {
                                handleCreateGroupFromRepo(row.repo)
                              }
                            }}
                          >
                            <FolderPlus className="size-3.5" />
                            New group from project
                          </DropdownMenuItem>
                          {projectGroups.length > 0 ? (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <FolderInput className="size-3.5" />
                                Move to group
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {projectGroups.map((group) => (
                                  <DropdownMenuItem
                                    key={group.id}
                                    disabled={row.repo?.projectGroupId === group.id}
                                    onSelect={() => {
                                      if (row.repo) {
                                        handleMoveProjectToGroup(row.repo, group.id)
                                      }
                                    }}
                                  >
                                    <span className="max-w-48 truncate">{group.name}</span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          ) : null}
                          {row.repo.projectGroupId ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                if (row.repo) {
                                  handleRemoveProjectFromGroup(row.repo)
                                }
                              }}
                            >
                              <CircleX className="size-3.5" />
                              Remove from group
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => {
                              if (row.repo) {
                                handleRemoveProject(row.repo)
                              }
                            }}
                          >
                            <Trash2 className="size-3.5" />
                            Remove Project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}

                    {row.repo && groupBy === 'repo' ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {createState?.disabled ? (
                            <span
                              className="inline-flex cursor-not-allowed"
                              tabIndex={0}
                              aria-label={createState.ariaLabel}
                              onKeyDown={stopRepoHeaderKeyboardToggle}
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="pointer-events-none size-5 shrink-0 rounded-md text-muted-foreground transition-opacity opacity-60"
                                aria-label={createState.ariaLabel}
                                disabled
                              >
                                <Plus className="size-3" />
                              </Button>
                            </span>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="size-5 shrink-0 rounded-md text-muted-foreground hover:bg-accent/70 hover:text-foreground transition-opacity"
                              aria-label={
                                createState?.ariaLabel ?? `Create workspace for ${row.label}`
                              }
                              onKeyDown={stopRepoHeaderKeyboardToggle}
                              onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                if (row.repo) {
                                  handleCreateForRepo(row.repo.id)
                                }
                              }}
                            >
                              <Plus className="size-3" />
                            </Button>
                          )}
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          {createState?.tooltip ?? `Create workspace for ${row.label}`}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
              )
            }

            const renderWorktreeRow = (
              itemRow: WorktreeItemRow,
              nested: boolean,
              lineageChildren?: React.ReactNode,
              forceActiveSurface = false
            ) => {
              const lineageToggleGroupKey = itemRow.lineageGroupKey
              // Why: child cards render inside the parent card body, so their
              // first nested level starts flush with that inset.
              const paddingDepth = nested ? Math.max(0, itemRow.depth - 1) : itemRow.depth
              // Why: ungrouped mode keeps workspace cards flush; grouped modes
              // indent top-level cards under their visible section header.
              const basePadding = !nested && groupBy !== 'none' ? WORKTREE_GROUP_INDENT : 0
              const paddingLeft = basePadding + paddingDepth * LINEAGE_INDENT
              const worktreeDragGroupKey = groupKeyByWorktreeId.get(itemRow.worktree.id)
              const worktreeDragGroupIndex = groupIndexByWorktreeId.get(itemRow.worktree.id)
              return (
                <div
                  key={itemRow.worktree.id}
                  id={getWorktreeOptionId(itemRow.worktree.id)}
                  role="option"
                  aria-selected={selectedWorktreeIds.has(itemRow.worktree.id)}
                  aria-current={activeWorktreeId === itemRow.worktree.id ? 'page' : undefined}
                  data-worktree-drag-id={worktreeDragGroupKey ? itemRow.worktree.id : undefined}
                  data-worktree-drag-group-key={worktreeDragGroupKey}
                  data-worktree-drag-group-index={worktreeDragGroupIndex}
                  className={cn(
                    // Why: avoid transitioning 'transform' to prevent browser-side lag and flashing
                    // when TanStack Virtual programmatically repositions adjacent rows.
                    'relative transition-[opacity,filter] duration-150 ease-out',
                    highlightedRevealWorktreeId === itemRow.worktree.id &&
                      'scroll-to-current-workspace-reveal-highlight',
                    worktreeDragState.draggingWorktreeId === itemRow.worktree.id &&
                      // Why: the fixed drag preview is the visible affordance; leaving the
                      // source row translucent lets it bleed through sticky headers/footers.
                      'pointer-events-none opacity-0'
                  )}
                  data-scroll-reveal-highlight={
                    highlightedRevealWorktreeId === itemRow.worktree.id ? 'true' : undefined
                  }
                  // Why: nested child cards live inside the parent's clickable
                  // card body; bubbling would activate/edit the parent too.
                  onClick={nested ? stopNestedWorktreeCardBubble : undefined}
                  onClickCapture={handleWorktreeRowClickCapture}
                  onDoubleClick={nested ? stopNestedWorktreeCardBubble : undefined}
                  onDragStart={nested ? stopNestedWorktreeCardBubble : undefined}
                  onPointerDown={(event) =>
                    nested ? undefined : handleWorktreeRowPointerDown(event, itemRow.worktree.id)
                  }
                  style={{
                    paddingLeft: paddingLeft > 0 ? `${paddingLeft}px` : undefined
                  }}
                >
                  <WorktreeCard
                    worktree={itemRow.worktree}
                    repo={itemRow.repo}
                    isActive={activeWorktreeId === itemRow.worktree.id}
                    isCurrentWorktree={currentWorktreeId === itemRow.worktree.id}
                    // Why: a child-active parent should look active without
                    // running active-card side effects such as SSH reconnect UI.
                    isActiveSurface={forceActiveSurface || activeWorktreeId === itemRow.worktree.id}
                    isMultiSelected={selectedWorktreeIds.has(itemRow.worktree.id)}
                    selectedWorktrees={selectedWorktrees}
                    nativeDragEnabled={false}
                    onSelectionGesture={onSelectionGesture}
                    onContextMenuSelect={(event) => onContextMenuSelect(event, itemRow.worktree)}
                    onCardDragStart={handleWorktreeCardDragStart}
                    onCardDragEnd={clearWorktreeDrag}
                    hideRepoBadge={groupBy === 'repo'}
                    lineageChildCount={itemRow.lineageChildCount}
                    lineageCollapsed={itemRow.lineageCollapsed}
                    lineageChildren={lineageChildren}
                    onLineageToggle={
                      lineageToggleGroupKey
                        ? (event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            toggleGroupWithScrollAnchor(lineageToggleGroupKey)
                          }
                        : undefined
                    }
                  />
                </div>
              )
            }

            const renderLineageChildCard = (child: WorktreeItemRow) => {
              const isActive = activeWorktreeId === child.worktree.id
              const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
                event.preventDefault()
                event.stopPropagation()
                const selectionOnly = onSelectionGesture(event, child.worktree.id)
                if (selectionOnly) {
                  return
                }
                activateAndRevealWorktree(child.worktree.id)
                if (child.repo?.connectionId) {
                  const sshStatus =
                    useAppStore.getState().sshConnectionStates.get(child.repo.connectionId)
                      ?.status ?? 'disconnected'
                  if (sshStatus !== 'connected') {
                    setLineageReconnectWorktreeId(child.worktree.id)
                  }
                }
              }
              const lineageToggleGroupKey = child.lineageGroupKey
              return (
                <div
                  key={child.worktree.id}
                  style={{ paddingLeft: `${Math.max(0, child.depth - 1) * LINEAGE_INDENT}px` }}
                >
                  <WorktreeContextMenu
                    worktree={child.worktree}
                    selectedWorktrees={selectedWorktrees}
                    onContextMenuSelect={(event) => onContextMenuSelect(event, child.worktree)}
                  >
                    <div
                      id={getWorktreeOptionId(child.worktree.id)}
                      role="option"
                      aria-selected={selectedWorktreeIds.has(child.worktree.id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'relative flex cursor-pointer items-start gap-1.5 rounded-md border border-transparent px-2 py-1.5 transition-colors',
                        highlightedRevealWorktreeId === child.worktree.id &&
                          'scroll-to-current-workspace-reveal-highlight',
                        isActive
                          ? 'border-black/[0.015] bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-border/40 dark:bg-white/[0.10] dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
                          : 'worktree-sidebar-card-hover'
                      )}
                      data-scroll-reveal-highlight={
                        highlightedRevealWorktreeId === child.worktree.id ? 'true' : undefined
                      }
                      onClick={handleClick}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <span className="mt-[2px] flex w-4 shrink-0 justify-center pt-[2px]">
                        <WorktreeActivityStatusIndicator worktreeId={child.worktree.id} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] leading-tight text-foreground">
                          {child.worktree.displayName}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-1.5">
                          {child.repo && groupBy !== 'repo' ? (
                            <span className="flex h-[16px] shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-accent px-1.5 text-[10px] font-semibold leading-none text-foreground dark:bg-accent/50 dark:border-border/60">
                              <RepoBadgeMark color={child.repo.badgeColor} />
                              <span className="max-w-[6rem] truncate lowercase">
                                {child.repo.displayName}
                              </span>
                            </span>
                          ) : null}
                          <span className="truncate text-[10.5px] leading-none text-muted-foreground">
                            {branchDisplayName(child.worktree.branch)}
                          </span>
                        </div>
                        {child.worktree.linkedIssue || child.worktree.comment ? (
                          <div className="mt-1.5 truncate text-[10.5px] leading-tight text-muted-foreground">
                            {child.worktree.linkedIssue ? (
                              <span className="font-medium text-foreground/80">
                                #{child.worktree.linkedIssue}
                              </span>
                            ) : null}
                            {child.worktree.linkedIssue && child.worktree.comment ? '  ' : null}
                            {child.worktree.comment}
                          </div>
                        ) : null}
                        {showInlineAgentCards ? (
                          // Why: nested lineage children use this lightweight
                          // renderer instead of WorktreeCard, so their inline
                          // agent rows must be mounted here explicitly.
                          <WorktreeCardAgents
                            worktreeId={child.worktree.id}
                            className="mt-1 divide-y-0"
                          />
                        ) : null}
                        {child.lineageChildCount > 0 && lineageToggleGroupKey ? (
                          <div className="mt-1.5 flex min-w-0 justify-start">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  className="h-[18px] max-w-[8rem] gap-1 rounded-md border border-sidebar-border bg-sidebar px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-sidebar-ring"
                                  aria-label={`${child.lineageCollapsed ? 'Show' : 'Hide'} ${
                                    child.lineageChildCount
                                  } child ${
                                    child.lineageChildCount === 1 ? 'workspace' : 'workspaces'
                                  }`}
                                  aria-expanded={!child.lineageCollapsed}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    toggleGroupWithScrollAnchor(lineageToggleGroupKey)
                                  }}
                                >
                                  <Workflow className="size-2.5" />
                                  <span className="truncate">
                                    {child.lineageChildCount}{' '}
                                    {child.lineageChildCount === 1 ? 'child' : 'children'}
                                  </span>
                                  <ChevronDown
                                    className={cn(
                                      'size-2.5 transition-transform',
                                      child.lineageCollapsed && '-rotate-90'
                                    )}
                                  />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="right" sideOffset={8}>
                                {child.lineageCollapsed
                                  ? 'Show child workspaces'
                                  : 'Hide child workspaces'}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </WorktreeContextMenu>
                </div>
              )
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
                          children.length > 0
                            ? children.map((child) => renderLineageChildCard(child))
                            : undefined,
                          childIsActive
                        )
                      : null}
                  </div>
                </div>
              )
            }

            if (row.type === 'imported-worktrees-card') {
              const actionState = importedWorktreeCardActionState.get(row.repo.id)
              return (
                <div
                  key={vItem.key}
                  role="presentation"
                  data-worktree-virtual-row
                  data-worktree-virtual-row-key={String(vItem.key)}
                  data-worktree-virtual-row-start={vItem.start}
                  data-index={vItem.index}
                  ref={measureVirtualRowElement}
                  className="absolute left-0 right-0 top-0"
                  style={{ transform: getVirtualRowTransform(vItem.start) }}
                >
                  <ImportedWorktreesVisibilityCard
                    repoDisplayName={row.repo.displayName}
                    hiddenWorktrees={row.hiddenWorktrees}
                    placement={row.placement}
                    pending={actionState?.pending ?? false}
                    error={actionState?.error ?? null}
                    onShow={() => handleShowImportedWorktrees(row.repo.id)}
                    onKeepHidden={
                      canKeepImportedWorktreesHidden(row, actionState)
                        ? () => handleKeepImportedWorktreesHidden(row.repo.id)
                        : undefined
                    }
                  />
                </div>
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
    </div>
  )
})

type WorktreeListProps = {
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
}

export function installWorktreeVisibleRefreshVisibilityListener(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

const WorktreeList = React.memo(function WorktreeList({
  scrollOffsetRef,
  scrollAnchorRef
}: WorktreeListProps) {
  // ── Granular selectors (each is a primitive or shallow-stable ref) ──
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const groupBy = useAppStore((s) => s.groupBy)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
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
  const revealWorktreeInSidebar = useAppStore((s) => s.revealWorktreeInSidebar)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)

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

  // PR cache is needed for PR-status grouping and when the PR card property
  // is visible.
  const prCache = useAppStore((s) =>
    groupBy === 'pr-status' || cardProps.includes('pr') ? s.prCache : null
  )
  const settings = useAppStore((s) => s.settings)
  const sectionActivityTabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const sectionActivityBrowserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const sectionActivityPtyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const sectionActivityRuntimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const sectionActivityAgentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const sectionActivityMigrationUnsupportedByPtyId = useAppStore(
    (s) => s.migrationUnsupportedByPtyId
  )
  const sectionActivityRetainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)

  const sortEpoch = useAppStore((s) => s.sortEpoch)

  // Count of non-archived worktrees — used to detect structural changes
  // (add/remove) vs. pure reorders (score shifts) so the debounce below
  // can apply immediately when the list shape changes.
  const worktreeCount = useMemo(() => {
    let count = 0
    for (const worktree of allWorktrees) {
      if (!worktree.isArchived) {
        count++
      }
    }
    return count
  }, [allWorktrees])

  // Why debounce: sort scores include a time-decaying activity component.
  // Recomputing instantly on every sortEpoch bump (e.g. AI starting work,
  // terminal title changes) recalculates all scores with a fresh `now`,
  // causing worktrees to visibly jump even when the triggering event isn't
  // about the worktree the user is looking at.  Settling for a few seconds
  // lets rapid-fire events coalesce and prevents mid-interaction surprises.
  //
  // However, structural changes (worktree created or removed) must apply
  // immediately — a new worktree should appear at its correct sorted
  // position, not at the bottom for 3 seconds.
  const [debouncedSortEpoch, setDebouncedSortEpoch] = useState(sortEpoch)
  const prevWorktreeCountRef = useRef(worktreeCount)
  useEffect(() => {
    if (debouncedSortEpoch === sortEpoch) {
      return
    }

    // Detect add/remove by comparing worktree count.
    const structuralChange = worktreeCount !== prevWorktreeCountRef.current
    prevWorktreeCountRef.current = worktreeCount

    // Why: manual drag/drop is direct manipulation; delaying that repaint by
    // the smart-sort settle window makes a successful drop look broken.
    if (structuralChange || sortBy === 'manual') {
      setDebouncedSortEpoch(sortEpoch)
      return
    }

    const timer = setTimeout(() => setDebouncedSortEpoch(sortEpoch), SORT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [sortEpoch, debouncedSortEpoch, worktreeCount, sortBy])

  // Why a latching ref: we need to distinguish "app just started, no PTYs
  // have spawned yet" from "user closed all terminals mid-session." The
  // former should use the persisted sortOrder; the latter should keep using
  // the live smart score. A point-in-time `hasAnyLivePty` check conflates
  // the two. This ref flips to true once any PTY is observed and never
  // reverts, so the cold-start path is only used on actual cold start.
  const sessionHasHadPty = useRef(false)

  // ── Stable sort order ──────────────────────────────────────────
  // The sort order is cached and only recomputed when `sortEpoch` changes
  // (worktree add/remove, terminal activity, backend refresh, etc.).
  // Why: explicit selection also triggers local side-effects like clearing
  // `isUnread` and force-refreshing the branch PR cache. Those updates are
  // useful for card contents, but they must not participate in ordering or a
  // sequence of clicks will keep reshuffling the sidebar underneath the user.
  //
  // Why useMemo instead of useEffect: the sort order must be computed
  // synchronously *before* the worktrees memo reads it, otherwise the
  // first render (and epoch bumps) would use stale/empty data from the ref.
  // Why a ref alongside the memo: telemetry effects need access to the most
  // recently computed attention map without forcing every render to read it
  // from store state again. The ref captures whatever the memo last produced
  // for the smart branch.
  const lastAttentionByWorktreeRef = useRef<Map<string, WorktreeAttention> | null>(null)

  const sortedIds = useMemo(() => {
    const state = useAppStore.getState()
    const nonArchivedWorktrees = getAllWorktreesFromState(state).filter(
      (worktree) => !worktree.isArchived
    )

    // Why cold-start detection: smart-class resolution depends on the
    // agent-status snapshot (agentStatusByPaneKey) hydrating from the hook
    // server, which lands asynchronously after launch. Running the warm
    // comparator before that arrives would collapse every worktree to Class 4
    // and shuffle the sidebar against the comparator's tiebreakers. Restore
    // the pre-shutdown order from the persisted sortOrder snapshot until any
    // live PTY appears, then switch to the live class layer. See Edge case 8
    // in docs/smart-worktree-order-redesign.md.
    if (sortBy === 'smart' && !sessionHasHadPty.current) {
      // Why: `tabHasLivePty` (over `ptyIdsByTabId`) is the source of truth for
      // liveness — slept terminals retain `tab.ptyId` as a wake hint, so reading
      // it directly would falsely keep cold-start ordering off after restart.
      const hasAnyLivePty = Object.values(state.tabsByWorktree)
        .flat()
        .some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
      if (hasAnyLivePty) {
        sessionHasHadPty.current = true
      } else {
        nonArchivedWorktrees.sort(
          (a, b) => b.sortOrder - a.sortOrder || a.displayName.localeCompare(b.displayName)
        )
        lastAttentionByWorktreeRef.current = null
        return nonArchivedWorktrees.map((w) => w.id)
      }
    }

    const currentTabs = state.tabsByWorktree
    const now = Date.now()
    // Why precompute: this is the hot sidebar sort. Array.sort invokes the
    // comparator O(N log N) times. Build the per-worktree attention map ONCE
    // (O(E + N×T×H) where H = stateHistory length, bounded at 20) so the
    // comparator does O(1) map lookups instead of re-resolving per comparison.
    const attentionByWorktree =
      sortBy === 'smart'
        ? buildAttentionByWorktree(
            nonArchivedWorktrees,
            currentTabs,
            state.agentStatusByPaneKey,
            state.runtimePaneTitlesByTabId,
            state.ptyIdsByTabId,
            now,
            state.migrationUnsupportedByPtyId,
            state.terminalLayoutsByTabId
          )
        : new Map<string, WorktreeAttention>()
    lastAttentionByWorktreeRef.current = sortBy === 'smart' ? attentionByWorktree : null
    nonArchivedWorktrees.sort(buildWorktreeComparator(sortBy, repoMap, now, attentionByWorktree))
    return nonArchivedWorktrees.map((w) => w.id)
    // debouncedSortEpoch is an intentional trigger: it's not read inside the
    // memo, but its change signals that the sort order should be recomputed.
    // The debounce prevents jarring mid-interaction position shifts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSortEpoch, repoMap, sortBy])

  // Why a ref of prior class per worktree: smart_sort_class_1_promotion must
  // fire only on transitions INTO Class 1, not on every recompute that keeps
  // a worktree there. Suppressing repeats with a ref keeps the event signal
  // clean without growing component state.
  const prevClassByWorktreeIdRef = useRef<Map<string, SmartClass>>(new Map())
  // Why gate the first observation: when Smart mode first activates (app
  // start, or toggling away from Smart and back), the prev-class map is
  // empty, so every existing Class-1 worktree would look like a fresh
  // promotion and produce a burst of spurious events. Treat the first
  // observation as a silent baseline — populate the map but don't fire.
  const hasObservedSmartOnceRef = useRef<boolean>(false)

  useEffect(() => {
    const attention = lastAttentionByWorktreeRef.current
    if (sortBy !== 'smart' || !attention) {
      // Why reset: when the user switches off Smart, drop the prior-class map
      // so re-entering Smart doesn't fire stale promotion events for worktrees
      // whose state has since changed. Reset the first-observation gate too
      // so the next Smart-mode session starts with a fresh silent baseline.
      prevClassByWorktreeIdRef.current = new Map()
      hasObservedSmartOnceRef.current = false
      return
    }
    const next = new Map<string, SmartClass>()
    const isFirstObservation = !hasObservedSmartOnceRef.current
    for (const [worktreeId, info] of attention) {
      const prev = prevClassByWorktreeIdRef.current.get(worktreeId)
      if (!isFirstObservation && info.cls === 1 && prev !== 1 && info.cause) {
        track('smart_sort_class_1_promotion', { cause: info.cause })
      }
      next.set(worktreeId, info.cls)
    }
    prevClassByWorktreeIdRef.current = next
    hasObservedSmartOnceRef.current = true
  }, [sortBy, sortedIds])

  // Why retry on sortedIds changes: Smart can become active before attention
  // hydrates. Fire once when class data exists, then stay quiet until the user
  // leaves Smart so this never becomes a telemetry heartbeat.
  const hasTrackedSmartDistributionRef = useRef(false)
  useEffect(() => {
    if (sortBy !== 'smart') {
      hasTrackedSmartDistributionRef.current = false
      return
    }
    if (hasTrackedSmartDistributionRef.current) {
      return
    }
    const attention = lastAttentionByWorktreeRef.current
    if (!attention || attention.size === 0) {
      return
    }
    let class1 = 0
    let class2 = 0
    let class3 = 0
    let class4 = 0
    for (const info of attention.values()) {
      if (info.cls === 1) {
        class1++
      } else if (info.cls === 2) {
        class2++
      } else if (info.cls === 3) {
        class3++
      } else {
        class4++
      }
    }
    track('smart_sort_class_distribution', {
      class_1: class1,
      class_2: class2,
      class_3: class3,
      class_4: class4,
      total_worktrees: attention.size
    })
    hasTrackedSmartDistributionRef.current = true
  }, [sortBy, sortedIds])

  // Why fire on the transition: switching away from Smart is the user signal
  // we care about (regression). Use a ref to compare against the previous
  // value so we don't double-fire when sortBy momentarily round-trips.
  const prevSortByRef = useRef(sortBy)
  useEffect(() => {
    const prev = prevSortByRef.current
    prevSortByRef.current = sortBy
    if (prev === 'smart' && sortBy === 'recent') {
      track('smart_to_recent_switch', {})
    }
  }, [sortBy])

  // Persist the computed sort order so the sidebar can be restored after
  // restart. Only persist during live sessions (sessionHasHadPty latched) —
  // on cold start we are *reading* the persisted order, not overwriting it.
  useEffect(() => {
    if (sortBy !== 'smart' || sortedIds.length === 0 || !sessionHasHadPty.current) {
      return
    }
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    void (target.kind === 'environment'
      ? callRuntimeRpc(
          target,
          'worktree.persistSortOrder',
          { orderedIds: sortedIds },
          { timeoutMs: 15_000 }
        )
      : window.api.worktrees.persistSortOrder({ orderedIds: sortedIds }))
  }, [sortedIds, sortBy])

  // Flatten, filter, and apply stable sort order via the shared utility so
  // the card order always matches the Cmd+1–9 shortcut numbering.
  const visibleWorktrees = useMemo(() => {
    const ids = computeVisibleWorktreeIds(worktreesByRepo, sortedIds, {
      filterRepoIds,
      showSleepingWorkspaces,
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      hideDefaultBranchWorkspace,
      repoMap,
      worktreeLineageById
    })
    return ids.map((id) => worktreeMap.get(id)).filter((w): w is Worktree => w != null)
  }, [
    filterRepoIds,
    showSleepingWorkspaces,
    hideDefaultBranchWorkspace,
    repoMap,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    sortedIds,
    worktreeMap,
    worktreeLineageById,
    worktreesByRepo
  ])

  const worktrees = visibleWorktrees
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const toggleGroup = useAppStore((s) => s.toggleCollapsedGroup)

  // Why: manual repo header order is bound to state.repos. Recent/Smart derive
  // header order from the sorted visible worktree stream instead.
  const repos = useAppStore((s) => s.repos)
  const projectGroups = useAppStore((s) => s.projectGroups ?? EMPTY_PROJECT_GROUPS)
  const repoOrder = useMemo(() => {
    const map = new Map<string, number>()
    repos.forEach((r, i) => map.set(r.id, i))
    return map
  }, [repos])
  const [importedWorktreeCardActionState, setImportedWorktreeCardActionState] = useState<
    Map<string, ImportedWorktreeCardActionState>
  >(new Map())
  const importedWorktreesByRepo = useMemo(() => {
    const forceVisibleRepoIds = new Set(
      [...importedWorktreeCardActionState.entries()]
        .filter(([, state]) => state.forceVisible)
        .map(([repoId]) => repoId)
    )
    return buildImportedWorktreesCardCandidates({
      repos,
      detectedWorktreesByRepo,
      filterRepoIds,
      forceVisibleRepoIds
    })
  }, [detectedWorktreesByRepo, filterRepoIds, importedWorktreeCardActionState, repos])
  const placeholderRepoIds = useMemo(() => {
    if (groupBy !== 'repo' || projectGroups.length === 0) {
      return new Set<string>()
    }
    const filterSet = filterRepoIds.length > 0 ? new Set(filterRepoIds) : null
    return new Set(
      repos
        .filter((repo) => (worktreesByRepo[repo.id]?.length ?? 0) === 0)
        .filter((repo) => filterSet === null || filterSet.has(repo.id))
        .map((repo) => repo.id)
    )
  }, [filterRepoIds, groupBy, projectGroups.length, repos, worktreesByRepo])
  const allRepoIds = useMemo(() => repos.map((r) => r.id), [repos])
  const reorderReposAction = useAppStore((s) => s.reorderRepos)
  const projectGroupOrdering = getProjectGroupOrdering(groupBy, sortBy)
  const showSectionStatus = cardProps.includes('status')
  const sectionActivityState: WorktreeSectionActivityState = useMemo(() => {
    const current = useAppStore.getState()
    return {
      tabsByWorktree: sectionActivityTabsByWorktree,
      browserTabsByWorktree: sectionActivityBrowserTabsByWorktree,
      ptyIdsByTabId: sectionActivityPtyIdsByTabId,
      runtimePaneTitlesByTabId: sectionActivityRuntimePaneTitlesByTabId,
      agentStatusEpoch: sectionActivityAgentStatusEpoch,
      // Why: agentStatusByPaneKey can tick for same-state tool details. The
      // section counts only need structural status transitions, tracked by
      // agentStatusEpoch, so read the current map without subscribing to it.
      agentStatusByPaneKey: current.agentStatusByPaneKey,
      migrationUnsupportedByPtyId: sectionActivityMigrationUnsupportedByPtyId,
      retainedAgentsByPaneKey: sectionActivityRetainedAgentsByPaneKey
    }
  }, [
    sectionActivityAgentStatusEpoch,
    sectionActivityBrowserTabsByWorktree,
    sectionActivityMigrationUnsupportedByPtyId,
    sectionActivityPtyIdsByTabId,
    sectionActivityRetainedAgentsByPaneKey,
    sectionActivityRuntimePaneTitlesByTabId,
    sectionActivityTabsByWorktree
  ])
  const sectionActivityByGroupKey = useMemo(
    () =>
      showSectionStatus
        ? buildWorktreeSectionActivitySummaries({
            groupBy,
            worktrees,
            repoMap,
            prCache,
            workspaceStatuses,
            projectGroups,
            settings,
            state: sectionActivityState
          })
        : new Map<string, WorktreeSectionActivitySummary>(),
    [
      groupBy,
      prCache,
      projectGroups,
      repoMap,
      sectionActivityState,
      settings,
      showSectionStatus,
      workspaceStatuses,
      worktrees
    ]
  )

  // Build flat row list for rendering
  const rows: Row[] = useMemo(
    () =>
      buildRows(
        groupBy,
        worktrees,
        repoMap,
        prCache,
        collapsedGroups,
        repoOrder,
        workspaceStatuses,
        projectGroupOrdering,
        worktreeLineageById,
        worktreeMap,
        true,
        settings,
        projectGroups,
        placeholderRepoIds,
        importedWorktreesByRepo
      ),
    [
      groupBy,
      worktrees,
      repoMap,
      prCache,
      collapsedGroups,
      repoOrder,
      workspaceStatuses,
      projectGroupOrdering,
      worktreeLineageById,
      worktreeMap,
      settings,
      projectGroups,
      placeholderRepoIds,
      importedWorktreesByRepo
    ]
  )
  // Why: header/mode changes can shift entire groups, so remount the
  // virtualizer for those broad structure changes. Do not key on rows.length:
  // add/delete must keep the same row DOM long enough for the remaining rows
  // to animate upward and for the scroll anchor to hold the viewport steady.
  const viewportResetKey = useMemo(() => {
    const headers = rows
      .filter((r): r is GroupHeaderRow => r.type === 'header')
      .map((r) => r.key)
      .join(',')
    return `${groupBy}:lineage:${headers}`
  }, [groupBy, rows])

  // Why: derive the rendered item order from the post-buildRows() row list,
  // not the flat `worktrees` array, because grouping (groupBy: 'repo' or
  // 'pr-status') can reorder cards into grouped sections. Using the flat
  // order would cause Cmd+1–9 shortcuts to not match the visual card
  // positions when grouping is active.
  const renderedWorktrees = useMemo(
    () =>
      rows
        .filter((r): r is Extract<Row, { type: 'item' }> => r.type === 'item')
        .map((r) => r.worktree),
    [rows]
  )
  const renderedWorktreeIds = useMemo(
    () => renderedWorktrees.map((worktree) => worktree.id),
    [renderedWorktrees]
  )
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<Set<string>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)

  const prunedSelection = pruneWorktreeSelection(
    selectedWorktreeIds,
    selectionAnchorId,
    renderedWorktreeIds
  )
  // Why: filters/grouping can hide selected cards. Prune during render so
  // context menus and child rows never see stale ids for unrendered worktrees.
  if (!areWorktreeSelectionsEqual(selectedWorktreeIds, prunedSelection.selectedIds)) {
    setSelectedWorktreeIds(prunedSelection.selectedIds)
  }
  if (selectionAnchorId !== prunedSelection.anchorId) {
    setSelectionAnchorId(prunedSelection.anchorId)
  }

  const selectedWorktrees = useMemo(() => {
    if (selectedWorktreeIds.size === 0) {
      return []
    }
    return renderedWorktrees.filter((worktree) => selectedWorktreeIds.has(worktree.id))
  }, [renderedWorktrees, selectedWorktreeIds])

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
      // Plain click keeps its existing navigation behavior; modifier gestures
      // are selection-only so users can build a batch without switching away.
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

  // Why: full-page navigation views are not scoped to one worktree, so no
  // sidebar card should appear selected while one of them is active.
  const selectedSidebarWorktreeId =
    activeView === 'tasks' || activeView === 'activity' ? null : activeWorktreeId

  // Why layout effect instead of effect: the global Cmd/Ctrl+1–9 key handler
  // can fire immediately after React commits the new grouped/collapsed order.
  // Publishing after paint leaves a brief window where the sidebar shows the
  // new numbering but the shortcut cache still points at the previous order.
  useLayoutEffect(() => {
    setVisibleWorktreeIds(renderedWorktreeIds)
    // Why: collapsed/full-page sidebar states unmount the list. Clear the
    // rendered-order cache so shortcuts fall back to the live store snapshot.
    return () => setVisibleWorktreeIds([])
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
    (projectId: string) => {
      openModal('worktree-visibility', { repoId: projectId })
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
      await keepImportedWorktreesHiddenCard({
        projectId,
        updateRepo,
        setCardState: setImportedWorktreeCardState
      })
    },
    [setImportedWorktreeCardState, updateRepo]
  )

  const handleRemoveProject = useCallback(
    (repo: Repo) => {
      openModal('confirm-remove-folder', {
        repoId: repo.id,
        displayName: repo.displayName
      })
    },
    [openModal]
  )

  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const deleteProjectGroup = useAppStore((s) => s.deleteProjectGroup)
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

  const handleDeleteProjectGroup = useCallback((groupId: string, groupName: string) => {
    setProjectGroupDeleteDialog({ groupId, groupName })
  }, [])

  const handleConfirmDeleteProjectGroup = useCallback(async () => {
    if (!projectGroupDeleteDialog) {
      return
    }
    await deleteProjectGroup(projectGroupDeleteDialog.groupId)
  }, [deleteProjectGroup, projectGroupDeleteDialog])

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

  const pinWorktree = useCallback(
    (worktreeId: string) => {
      const current = worktreeMap.get(worktreeId)
      if (!current || current.isPinned) {
        return
      }
      void updateWorktreeMeta(worktreeId, { isPinned: true })
    },
    [updateWorktreeMeta, worktreeMap]
  )

  const pinWorktrees = useCallback(
    (worktreeIds: readonly string[]) => {
      const updates = new Map<string, { isPinned: true }>()
      for (const worktreeId of worktreeIds) {
        const current = worktreeMap.get(worktreeId)
        if (!current || current.isPinned) {
          continue
        }
        updates.set(worktreeId, { isPinned: true })
      }
      if (updates.size > 0) {
        void updateWorktreesMeta(updates)
      }
    },
    [updateWorktreesMeta, worktreeMap]
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
      // Why: a drag reorder is an explicit request for user-authored order.
      // Switch modes only after a real move so accidental click-drags do not
      // alter the user's selected sort.
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
      // Why: when the drop changes visual order, the board/sidebar must both
      // switch to Manual so the committed placement remains visible.
      if (result.shouldSwitchToManual) {
        setSortBy('manual')
      }
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
      void updateWorktreesMeta(result.updates)
    },
    [setSortBy, sortBy, updateWorktreesMeta, worktreeMap, workspaceStatuses]
  )

  // Why: hideDefaultBranchWorkspace is counted as a filter here so the
  // empty-sidebar escape hatch (Clear Filters button below) is reachable when
  // it's the only reason the list is empty — otherwise a user whose only
  // worktree is a default-branch row and who just toggled hide on would see
  // "No workspaces found" with no way back short of reopening the filter menu.
  const filterState = useMemo(
    () => ({ showSleepingWorkspaces, filterRepoIds, hideDefaultBranchWorkspace }),
    [showSleepingWorkspaces, filterRepoIds, hideDefaultBranchWorkspace]
  )
  const hasFilters = sidebarHasActiveFilters(filterState)
  const setShowSleepingWorkspaces = useAppStore((s) => s.setShowSleepingWorkspaces)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)

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
  }, [setShowSleepingWorkspaces, setFilterRepoIds, setHideDefaultBranchWorkspace, filterState])

  const handleRevealCurrentWorkspaceRequest = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const activeWorktree = worktreeMap.get(activeWorktreeId)
    if (!activeWorktree || activeWorktree.isArchived) {
      return
    }
    if (!worktrees.some((worktree) => worktree.id === activeWorktreeId)) {
      // Why: the toolbar action promises to reveal the current workspace; when
      // sidebar filters hide it, relax those filters before queuing the reveal.
      clearFilters()
    }
    revealWorktreeInSidebar(activeWorktreeId, { behavior: 'smooth', highlight: true })
  }, [activeWorktreeId, clearFilters, revealWorktreeInSidebar, worktreeMap, worktrees])

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
  // Why: Project Group headers can render before workspace rows load, but when
  // active filters hide everything the Clear Filters empty state must win.
  if (rows.length === 0 || filtersHideAllRows) {
    return (
      <div data-worktree-sidebar-container className="relative min-h-0 flex-1">
        <div className="worktree-sidebar-scrollbar flex h-full flex-col overflow-y-scroll overflow-x-hidden pl-1 scrollbar-sleek pt-px">
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-[11px] text-muted-foreground">
            <span>No workspaces found</span>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-[11px] px-2.5 py-1 rounded-md cursor-pointer hover:bg-accent transition-colors"
              >
                <CircleX className="size-3.5" />
                Clear Filters
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
          projectGroupNameDialog?.type === 'rename' ? 'Rename Project Group' : 'New Project Group'
        }
        description={
          projectGroupNameDialog?.type === 'rename'
            ? 'Update the group name shown in the sidebar.'
            : 'Create a group and move this project into it.'
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
      <ProjectGroupDeleteDialog
        open={projectGroupDeleteDialog !== null}
        groupName={projectGroupDeleteDialog?.groupName ?? ''}
        onOpenChange={(open) => {
          if (!open) {
            setProjectGroupDeleteDialog(null)
          }
        }}
        onConfirm={handleConfirmDeleteProjectGroup}
      />
      <VirtualizedWorktreeViewport
        key={viewportResetKey}
        rows={rows}
        activeWorktreeId={selectedSidebarWorktreeId}
        currentWorktreeId={activeWorktreeId}
        groupBy={groupBy}
        projectGroupOrdering={projectGroupOrdering}
        toggleGroup={toggleGroup}
        collapsedGroups={collapsedGroups}
        handleCreateForRepo={handleCreateForRepo}
        handleOpenRepoSettings={handleOpenRepoSettings}
        handleOpenWorktreeVisibility={handleOpenWorktreeVisibility}
        handleShowImportedWorktrees={handleShowImportedWorktrees}
        handleKeepImportedWorktreesHidden={handleKeepImportedWorktreesHidden}
        importedWorktreeCardActionState={importedWorktreeCardActionState}
        handleRemoveProject={handleRemoveProject}
        handleCreateGroupFromRepo={handleCreateGroupFromRepo}
        handleMoveProjectToGroup={handleMoveProjectToGroup}
        handleRemoveProjectFromGroup={handleRemoveProjectFromGroup}
        handleRenameProjectGroup={handleRenameProjectGroup}
        handleDeleteProjectGroup={handleDeleteProjectGroup}
        activeModal={activeModal}
        pendingRevealWorktree={pendingRevealWorktree}
        clearPendingRevealWorktreeId={clearPendingRevealWorktreeId}
        worktrees={worktrees}
        selectedWorktreeIds={selectedWorktreeIds}
        selectedWorktrees={selectedWorktrees}
        onSelectionGesture={updateSelectionForGesture}
        onContextMenuSelect={selectForContextMenu}
        repoMap={repoMap}
        worktreeMap={worktreeMap}
        worktreeLineageById={worktreeLineageById}
        repoOrder={repoOrder}
        allRepoIds={allRepoIds}
        reorderRepos={(orderedIds) => {
          void reorderReposAction(orderedIds)
        }}
        prCache={prCache}
        workspaceStatuses={workspaceStatuses}
        projectGroups={projectGroups}
        onMoveWorktreeToStatus={moveWorktreeToStatus}
        onMoveWorktreesToStatus={moveWorktreesToStatus}
        onPinWorktree={pinWorktree}
        onPinWorktrees={pinWorktrees}
        onDropWorktreesOnWorkspaceBoard={dropWorktreesOnWorkspaceBoard}
        shouldShowWorkspaceBoardDropIndicator={shouldShowWorkspaceBoardDropIndicator}
        onReorderWorktrees={reorderWorktrees}
        showInlineAgentCards={cardProps.includes('inline-agents')}
        showSectionStatus={showSectionStatus}
        sectionActivityByGroupKey={sectionActivityByGroupKey}
        scrollOffsetRef={scrollOffsetRef}
        scrollAnchorRef={scrollAnchorRef}
      />
    </>
  )
})

export default WorktreeList
