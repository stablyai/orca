/* eslint-disable max-lines */
import React, { useMemo, useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react'
import {
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
  FolderX,
  Plus,
  Shapes,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { AppState } from '@/store/types'
import {
  getAllWorktreesFromState,
  useAllWorktrees,
  useRepoMap,
  useWorktreeMap
} from '@/store/selectors'
import WorktreeCard from './WorktreeCard'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { FolderWorkspaceComposerDialog } from './FolderWorkspaceComposerDialog'
import { PendingWorktreeRow } from './PendingWorktreeRow'
import { SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT } from './WorktreeCardAgents'
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
  FolderWorkspace,
  ProjectGroup,
  ProjectOrderBy,
  WorktreeLineage,
  WorktreeMeta,
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
import { deriveRunningAgentSendTargets } from '@/lib/running-agent-targets'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'
import {
  type Row,
  type WorktreeGroupBy,
  ALL_GROUP_KEY,
  PINNED_GROUP_KEY,
  buildRows,
  getGroupKeysForWorktree,
  getLineageGroupKey
} from './worktree-list-groups'
import {
  estimateRenderRowSize,
  extractWorktreeVirtualRowIndexes,
  getActiveStickyHeaderIndexForScroll,
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
  getWorkspaceStatusGroupKey,
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
import { getEmptyProjectPlaceholderRepoIds } from './empty-project-placeholder-repos'
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
import { useFolderWorkspacePathStatusCacheExpiryTick } from '@/lib/folder-workspace-path-status-cache-expiry'
import {
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from '@/lib/folder-workspace-path-status'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import {
  SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
  type ScrollToCurrentWorkspaceRevealRequestDetail
} from '@/lib/scroll-to-current-workspace-status'
import { getSidebarOrderedRepoHeaderIdsByBucket } from './project-header-drop'
import { isRepoHeaderActionTarget, useRepoHeaderDrag } from './project-header-drag'
import {
  buildManualOrderUpdatesForGroupDrop,
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
  resolveWorkspaceKanbanCardDropCommitTarget,
  type WorkspaceKanbanCardTrackedDropTarget
} from './workspace-kanban-card-pointer-drag-dom'
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
  getWorktreeSidebarDragRectsForGroup,
  refreshWorktreeSidebarDragSession,
  type WorktreeSidebarDragRect,
  type WorktreeSidebarDragSession,
  type WorktreeSidebarDragPoint
} from './worktree-sidebar-drag-autoscroll'
import {
  computeWorktreeSidebarDropPreview,
  resolveWorktreeSidebarStatusDropCommitTarget,
  type WorktreeSidebarStatusDropTarget,
  type WorktreeSidebarTrackedStatusDropTarget,
  type WorktreeSidebarDropPreview
} from './worktree-sidebar-drop-preview'
import { resolveProjectGroupHeaderColor } from './project-header-color'
import {
  areWorktreeSelectionsEqual,
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeSelection
} from './worktree-multi-selection'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRepoHeaderCreateState } from './repo-header-create-state'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { getRepositoryIconSectionId } from '@/components/settings/repository-settings-targets'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { ProjectGroupDeleteDialog } from './ProjectGroupDeleteDialog'
import { selectProjectGroupRemovalTargets } from '@/store/slices/project-group-removal-targets'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { RepoForkIndicator } from '@/components/repo/repo-fork-indicator'
import ImportedWorktreesVisibilityLine from './ImportedWorktreesVisibilityLine'
import {
  keepImportedWorktreesHiddenCard,
  showImportedWorktreesCard,
  type ImportedWorktreeCardActionState
} from './imported-worktrees-card-actions'
import { buildImportedWorktreesCardCandidates } from './imported-worktrees-card-candidates'
import {
  WORKTREE_SECTION_HEADER_PADDING_LEFT,
  getProjectGroupHeaderPaddingLeft,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset
} from './worktree-list-indentation'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  isConfirmedStaleFolderPathStatus,
  type FolderWorkspacePathStatus
} from '../../../../shared/folder-workspace-path-status'
import {
  getFolderWorkspaceRevealGroupKeys,
  getKnownSidebarWorktreeById,
  sidebarWorkspaceStillExists
} from './worktree-list-folder-reveal'

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

// How long to wait after a sortEpoch bump before actually re-sorting.
// Prevents jarring position shifts when background events (AI starting work,
// terminal title changes) trigger score recalculations.
const SORT_SETTLE_MS = 3_000
const USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS = 500
const EMPTY_PROJECT_GROUPS: readonly ProjectGroup[] = []
const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = {}
const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: AppState['terminalLayoutsByTabId'] = {}
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

function handleRepoHeaderActionPointerDown(event: React.PointerEvent<HTMLElement>): void {
  event.stopPropagation()
}

function stopRepoHeaderMenuEvent(event: React.SyntheticEvent<HTMLElement>): void {
  event.stopPropagation()
}

function shouldIgnoreRepoHeaderToggle(event: React.SyntheticEvent<HTMLElement>): boolean {
  return isRepoHeaderActionTarget(event.target, event.currentTarget)
}

function getWorktreeOptionId(worktreeId: string): string {
  return `worktree-list-option-${encodeURIComponent(worktreeId)}`
}

function markSidebarWorktreeActiveImmediately(worktreeId: string): void {
  const nextOption = document.getElementById(getWorktreeOptionId(worktreeId))
  if (!nextOption) {
    return
  }

  const sidebar =
    nextOption.closest<HTMLElement>('[data-worktree-sidebar]') ??
    document.querySelector<HTMLElement>('[data-worktree-sidebar]')
  const previousOption = sidebar?.querySelector<HTMLElement>('[role="option"][aria-current="page"]')
  if (previousOption && previousOption !== nextOption) {
    previousOption.removeAttribute('aria-current')
  }

  nextOption.setAttribute('aria-current', 'page')
  sidebar
    ?.querySelectorAll<HTMLElement>(
      '[data-worktree-card-surface][data-worktree-card-active="true"]'
    )
    .forEach((surface) => {
      if (!nextOption.contains(surface)) {
        surface.removeAttribute('data-worktree-card-active')
      }
    })
  nextOption
    .querySelector<HTMLElement>('[data-worktree-card-surface]')
    ?.setAttribute('data-worktree-card-active', 'true')
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
  return visibility === 'show' ? 'Hide non-Orca worktrees' : 'Show hidden worktrees'
}

const SIDEBAR_POINTER_DRAG_THRESHOLD_PX = 4
type VirtualizedWorktreeViewportProps = {
  rows: Row[]
  activeWorktreeId: string | null
  currentWorktreeId: string | null
  groupBy: WorktreeGroupBy
  projectOrderBy: ProjectOrderBy
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
  handleCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
  activeModal: string
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  clearPendingRevealWorktreeId: () => void
  agentSendTargetWorktreeId: string | null
  worktrees: Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onImmediateWorktreeActivate: (worktreeId: string) => void
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
  prCache: Record<string, unknown> | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
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
  // Why: broad grouping changes still remount the viewport, while add/delete
  // stays mounted for row-key anchoring and layout animation. These refs bridge
  // both paths so the virtualizer never falls back to scrollTop 0.
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
}

type WorktreeItemRow = Extract<Row, { type: 'item' }>
type FolderWorkspaceItemRow = Extract<Row, { type: 'folder-workspace' }>

function formatSectionActivityLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

function SectionMetricsBadge({ count }: { count: number }): React.JSX.Element {
  const totalLabel = formatSectionActivityLabel(count, 'workspace')

  return (
    <span
      className="inline-flex h-4 shrink-0 overflow-hidden rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90"
      aria-label={totalLabel}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-full min-w-4 items-center justify-center px-1.5">
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {totalLabel}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

function FolderPathStatusIndicator({
  status
}: {
  status: FolderWorkspacePathStatus | null | undefined
}): React.JSX.Element | null {
  const title = getFolderWorkspacePathStatusTitle(status)
  if (!status || status.exists || !title) {
    return null
  }
  const destructive = isConfirmedStaleFolderPathStatus(status)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]',
            destructive ? 'text-destructive' : 'text-muted-foreground'
          )}
          aria-label={title}
        >
          <FolderX className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          <div className="text-muted-foreground">
            {getFolderWorkspacePathStatusDescription(status)}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
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
  latestBoardDropTarget: WorkspaceKanbanCardTrackedDropTarget | null
  latestStatusDropTarget: WorktreeSidebarTrackedStatusDropTarget | null
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

function updateLatestWorktreeStatusDropTarget(
  drag: WorktreePointerDrag,
  target: WorktreeSidebarStatusDropTarget,
  preview: WorktreeSidebarDropPreview | null
): void {
  drag.latestStatusDropTarget =
    target.status || target.isPinDrop
      ? {
          target,
          preview,
          x: drag.currentX,
          y: drag.currentY
        }
      : null
}

function getWorktreeVirtualRowTransform(start: number, previewOffset: number): string {
  const base = getVirtualRowTransform(start)
  return previewOffset === 0 ? base : `${base} translateY(${previewOffset}px)`
}

function getPointerDropStatusTarget(args: {
  container: HTMLElement
  x: number
  y: number
}): WorktreeSidebarStatusDropTarget {
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

function shouldPreferSidebarStatusDropTarget(args: {
  sourceGroupKey: string
  target: WorktreeSidebarStatusDropTarget
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): boolean {
  if (args.target.isPinDrop) {
    return true
  }
  if (!args.target.status) {
    return false
  }
  const sourceStatus = getWorkspaceStatusFromGroupKey(args.sourceGroupKey, args.workspaceStatuses)
  // Why: source-group edge zones overlap adjacent status sections; the visible
  // section under the pointer must win so the guide and committed drop agree.
  return sourceStatus !== null && args.target.status !== sourceStatus
}

function isWorktreeItemRow(row: Row): row is WorktreeItemRow {
  return row.type === 'item'
}

export function renderRowContainsWorktree(row: RenderRow, worktreeId: string | null): boolean {
  if (worktreeId === null) {
    return false
  }
  if (row.type === 'folder-workspace') {
    return folderWorkspaceKey(row.folderWorkspace.id) === worktreeId
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
  if (row.type === 'pending-creation') {
    return `pending:${row.creationId}`
  }
  if (row.type === 'folder-workspace') {
    return `folder-workspace:${row.folderWorkspace.id}`
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
    if (
      row.type === 'imported-worktrees-card' ||
      row.type === 'pending-creation' ||
      row.type === 'folder-workspace'
    ) {
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
  projectOrderBy,
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
  handleCreateFolderWorkspace,
  activeModal,
  pendingRevealWorktree,
  clearPendingRevealWorktreeId,
  agentSendTargetWorktreeId,
  worktrees,
  folderWorkspaces,
  selectedWorktreeIds,
  selectedWorktrees,
  onSelectionGesture,
  onImmediateWorktreeActivate,
  onContextMenuSelect,
  repoMap,
  worktreeMap,
  worktreeLineageById,
  repoOrder,
  allRepoIds,
  prCache,
  workspaceStatuses,
  projectGroups = EMPTY_PROJECT_GROUPS,
  onMoveWorktreeToStatus,
  onMoveWorktreesToStatus,
  onMoveWorktreesToStatusAtIndex,
  onPinWorktree,
  onPinWorktrees,
  onDropWorktreesOnWorkspaceBoard,
  shouldShowWorkspaceBoardDropIndicator,
  onReorderWorktrees,
  scrollOffsetRef,
  scrollAnchorRef
}: VirtualizedWorktreeViewportProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const suppressMeasurementAdjustmentUntilRef = useRef(0)
  const directScrollInputUntilRef = useRef(0)
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)
  const [worktreeDragState, setWorktreeDragState] = useState<WorktreeRowDragState>(
    WORKTREE_ROW_DRAG_INITIAL_STATE
  )
  const [pendingRevealRetryTick, setPendingRevealRetryTick] = useState(0)
  const [documentVisibilityRevision, setDocumentVisibilityRevision] = useState(0)
  const [highlightedRevealWorktreeId, setHighlightedRevealWorktreeId] = useState<string | null>(
    null
  )
  const setRenamingWorktreeId = useAppStore((s) => s.setRenamingWorktreeId)
  const worktreeDragSessionRef = useRef<WorktreeSidebarDragSession | null>(null)
  const worktreePointerDragRef = useRef<WorktreePointerDrag | null>(null)
  const worktreePointerAutoscrollFrameIdRef = useRef<number | null>(null)
  const worktreePointerAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const worktreeNativeAutoscrollFrameIdRef = useRef<number | null>(null)
  const worktreeNativeAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const worktreeNativeLatestPointRef = useRef<WorktreeSidebarDragPoint | null>(null)
  const pendingRevealRetryRef = useRef<{ worktreeId: string; count: number } | null>(null)
  const pendingRevealFrameIdsRef = useRef<Set<number>>(new Set())
  const revealHighlightFrameIdRef = useRef<number | null>(null)
  const revealHighlightTimeoutRef = useRef<number | null>(null)
  const cancelPendingRevealFrames = useCallback(() => {
    for (const frameId of pendingRevealFrameIdsRef.current) {
      window.cancelAnimationFrame(frameId)
    }
    pendingRevealFrameIdsRef.current.clear()
  }, [])
  const schedulePendingRevealFrame = useCallback((callback: FrameRequestCallback) => {
    const frameId = window.requestAnimationFrame((time) => {
      pendingRevealFrameIdsRef.current.delete(frameId)
      callback(time)
    })
    pendingRevealFrameIdsRef.current.add(frameId)
  }, [])
  const clearRevealHighlightFrame = useCallback(() => {
    if (revealHighlightFrameIdRef.current !== null) {
      window.cancelAnimationFrame(revealHighlightFrameIdRef.current)
      revealHighlightFrameIdRef.current = null
    }
  }, [])
  const clearRevealHighlightTimeout = useCallback(() => {
    if (revealHighlightTimeoutRef.current !== null) {
      window.clearTimeout(revealHighlightTimeoutRef.current)
      revealHighlightTimeoutRef.current = null
    }
  }, [])
  const flashRevealedWorktree = useCallback(
    (worktreeId: string) => {
      clearRevealHighlightTimeout()
      clearRevealHighlightFrame()
      // Why: remove before add restarts the CSS glow when the user repeatedly
      // asks to reveal the same active workspace.
      setHighlightedRevealWorktreeId(null)
      revealHighlightFrameIdRef.current = window.requestAnimationFrame(() => {
        revealHighlightFrameIdRef.current = null
        setHighlightedRevealWorktreeId(worktreeId)
        revealHighlightTimeoutRef.current = window.setTimeout(() => {
          revealHighlightTimeoutRef.current = null
          setHighlightedRevealWorktreeId(null)
        }, 1500)
      })
    },
    [clearRevealHighlightFrame, clearRevealHighlightTimeout]
  )
  const suppressWorktreeClickUntilRef = useRef(0)
  const hasProjectGroups = projectGroups.length > 0
  const canReorderRepoHeaders = groupBy === 'repo' && projectOrderBy === 'manual'
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
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
  const reorderRepos = useAppStore((s) => s.reorderRepos)

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

  // Why: a project reorder relocates a whole group (header + its worktree
  // rows) but leaves totalSize unchanged, so the current scrollTop is already
  // the visually-stable position. Flag direct scroll input (same refs as
  // markDirectScrollInput, defined later) so the scroll-anchor restore effect
  // skips re-pinning the old top row — otherwise it chases the moved row and
  // yanks the viewport, which is the "jumpy" drop.
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
  const computeWorktreeDropForGroup = useCallback(
    (args: {
      pointerY: number
      groupKey: string
      rects: readonly WorktreeSidebarDragRect[]
      draggedIds: readonly string[]
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
        draggedIds: args.draggedIds
      })
    },
    [worktreeDragUnitGroups]
  )
  const computeWorktreeDrop = useCallback(
    (pointerY: number): WorktreeSidebarDropPreview | null => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return null
      }
      return computeWorktreeDropForGroup({
        pointerY,
        groupKey: session.sourceGroupKey,
        rects: session.rects,
        draggedIds: session.reorderUnitDraggedIds
      })
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
      return computeWorktreeDropForGroup({
        pointerY: args.pointerY,
        groupKey,
        rects: getWorktreeSidebarDragRectsForGroup(container, groupKey),
        draggedIds: args.draggedIds
      })
    },
    [computeWorktreeDropForGroup]
  )
  const renderRows = useMemo(() => buildRenderableRows(rows), [rows])
  const sidebarRepoHeaderIdsByBucket = useMemo(
    () => getSidebarOrderedRepoHeaderIdsByBucket(rows),
    [rows]
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
  const commitProjectGroupOrder = useCallback(
    (repoId: string, projectGroupId: string | null, order: number) => {
      void moveProjectToGroup(repoId, projectGroupId, order)
    },
    [moveProjectToGroup]
  )
  // Drag is only meaningful when repo headers are using manual order. The
  // controller is still constructed for hook order stability when inert.
  const repoDrag = useRepoHeaderDrag({
    orderedRepoIds: allRepoIds,
    sidebarRepoHeaderIdsByBucket,
    repoById: repoMap,
    usesProjectGroupOrdering: hasProjectGroups,
    onCommitRepoOrder: commitRepoReorder,
    onCommitProjectGroupOrder: commitProjectGroupOrder,
    getScrollContainer: () => scrollRef.current
  })
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
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const {
    folderWorkspacePathStatuses,
    fetchFolderWorkspacePathStatus,
    getFolderWorkspacePathStatusCacheKey,
    getFreshFolderWorkspacePathStatus,
    activeRuntimeEnvironmentId
  } = useAppStore(
    useShallow((s) => ({
      folderWorkspacePathStatuses: s.folderWorkspacePathStatuses,
      fetchFolderWorkspacePathStatus: s.fetchFolderWorkspacePathStatus,
      getFolderWorkspacePathStatusCacheKey: s.getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus: s.getFreshFolderWorkspacePathStatus,
      activeRuntimeEnvironmentId: s.settings?.activeRuntimeEnvironmentId ?? null
    }))
  )
  const folderPathStatusRepoMembershipKey = useMemo(
    () =>
      allRepoIds
        .map((repoId) => {
          const repo = repoMap.get(repoId)
          return `${repoId}:${repo?.path ?? ''}:${repo?.projectGroupId ?? ''}:${repo?.connectionId ?? ''}`
        })
        .join('\0'),
    [allRepoIds, repoMap]
  )
  const folderPathStatusSshConnectionKey = useMemo(
    () =>
      [...sshConnectionStates.entries()]
        .map(([connectionId, state]) => `${connectionId}:${state.status}`)
        .sort()
        .join('\0'),
    [sshConnectionStates]
  )
  const folderPathStatusCacheExpiryTick = useFolderWorkspacePathStatusCacheExpiryTick(
    folderWorkspacePathStatuses
  )
  useEffect(() => {
    const requests = new Map<string, Parameters<typeof fetchFolderWorkspacePathStatus>[0]>()
    for (const group of projectGroups) {
      if (group.parentPath) {
        const request = { scope: 'project-group' as const, projectGroupId: group.id }
        requests.set(getFolderWorkspacePathStatusCacheKey(request), request)
      }
    }
    for (const workspace of folderWorkspaces) {
      const request = { scope: 'folder-workspace' as const, folderWorkspaceId: workspace.id }
      requests.set(getFolderWorkspacePathStatusCacheKey(request), request)
    }
    for (const request of requests.values()) {
      void fetchFolderWorkspacePathStatus(request, { force: true })
    }
  }, [
    activeRuntimeEnvironmentId,
    fetchFolderWorkspacePathStatus,
    folderPathStatusRepoMembershipKey,
    folderPathStatusSshConnectionKey,
    folderWorkspaces,
    getFolderWorkspacePathStatusCacheKey,
    projectGroups
  ])
  const getCachedFolderWorkspacePathStatus = useCallback(
    (request: Parameters<typeof fetchFolderWorkspacePathStatus>[0]) => {
      const cacheKey = getFolderWorkspacePathStatusCacheKey(request)
      // Why: expired negative statuses should not keep disabling folder
      // workspaces while a fresh status request is in flight.
      void folderWorkspacePathStatuses[cacheKey]
      void folderPathStatusCacheExpiryTick
      return getFreshFolderWorkspacePathStatus(request)
    },
    [
      folderWorkspacePathStatuses,
      folderPathStatusCacheExpiryTick,
      getFolderWorkspacePathStatusCacheKey,
      getFreshFolderWorkspacePathStatus
    ]
  )
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
    // Why: TanStack memoizes range extraction by function identity. Header
    // indexes must be deps so grouping/filtering cannot leave stale sticky
    // slots rendering ordinary worktree rows.
    rangeExtractor: useCallback(
      (range: Range) => {
        stickyRangeStartIndexRef.current = range.startIndex
        return extractWorktreeVirtualRowIndexes({ range, stickyHeaderIndexes })
      },
      [stickyHeaderIndexes]
    ),
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

    if (agentSendTargetWorktreeId !== pendingRevealWorktree.worktreeId) {
      const folderGroupKeys = getFolderWorkspaceRevealGroupKeys(
        pendingRevealWorktree.worktreeId,
        folderWorkspaces,
        projectGroups
      )
      if (folderGroupKeys.length > 0) {
        for (const groupKey of folderGroupKeys) {
          if (collapsedGroups.has(groupKey)) {
            toggleGroup(groupKey)
          }
        }
      } else {
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
    }

    let cancelled = false
    schedulePendingRevealFrame(() => {
      if (cancelled) {
        return
      }
      const targetWorktreeStillExists = sidebarWorkspaceStillExists(
        pendingRevealWorktree.worktreeId,
        worktrees,
        folderWorkspaces
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
            schedulePendingRevealFrame(() => {
              if (!cancelled) {
                setPendingRevealRetryTick((tick) => tick + 1)
              }
            })
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
          if (pendingRevealWorktree.beginRename) {
            setRenamingWorktreeId(pendingRevealWorktree.worktreeId)
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
    return () => {
      cancelled = true
      cancelPendingRevealFrames()
    }
  }, [
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
    workspaceStatuses,
    settings,
    projectGroups,
    pendingRevealRetryTick,
    flashRevealedWorktree,
    setRenamingWorktreeId,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames
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
        projectOrderBy,
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
      projectOrderBy,
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
        // Why: sidebar drag previews, autoscroll frames, and reveal row
        // snapshots are tied to the scroll root; clear them before it disappears.
        cancelPendingRevealFrames()
        clearRevealHighlightFrame()
        clearRevealHighlightTimeout()
        clearWorktreeDrag()
      }
      scrollRef.current = node
    },
    [
      cancelPendingRevealFrames,
      clearRevealHighlightFrame,
      clearRevealHighlightTimeout,
      clearWorktreeDrag
    ]
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
    drag.latestBoardDropTarget = {
      target: boardTarget,
      x: drag.currentX,
      y: drag.currentY
    }
    if (boardTarget.status || boardTarget.isPinDrop) {
      drag.latestStatusDropTarget = null
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

    const sidebarContainer = scrollRef.current
    const preferredStatusTarget = sidebarContainer
      ? getPointerDropStatusTarget({
          container: sidebarContainer,
          x: drag.currentX,
          y: drag.currentY
        })
      : { status: null, isPinDrop: false }
    if (
      shouldPreferSidebarStatusDropTarget({
        sourceGroupKey: drag.sourceGroupKey,
        target: preferredStatusTarget,
        workspaceStatuses
      })
    ) {
      const statusDrop = preferredStatusTarget.status
        ? computeWorktreeStatusDrop({
            pointerY: drag.currentY,
            status: preferredStatusTarget.status,
            draggedIds: drag.draggedIds
          })
        : null
      if (statusDrop) {
        updateLatestWorktreeStatusDropTarget(drag, preferredStatusTarget, statusDrop)
        clearWorkspaceKanbanSidebarDropTargetVisual()
        setDragOverStatus(null)
        setPinDragOver(false)
        setWorktreeDragState((prev) =>
          prev.dropIndex === statusDrop.dropIndex &&
          prev.dropIndicatorY === statusDrop.dropIndicatorY &&
          prev.pointerY === drag.currentY &&
          areWorktreeDragPreviewOffsetsEqual(
            prev.previewOffsetsByWorktreeId,
            statusDrop.previewOffsetsByWorktreeId
          )
            ? prev
            : { ...prev, ...statusDrop, pointerY: drag.currentY }
        )
        return
      }
      updateLatestWorktreeStatusDropTarget(drag, preferredStatusTarget, statusDrop)
      setDragOverStatus(preferredStatusTarget.status)
      setPinDragOver(preferredStatusTarget.isPinDrop)
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
    if (!drop) {
      const target = preferredStatusTarget
      const statusDrop = target.status
        ? computeWorktreeStatusDrop({
            pointerY: drag.currentY,
            status: target.status,
            draggedIds: drag.draggedIds
          })
        : null
      if (statusDrop) {
        updateLatestWorktreeStatusDropTarget(drag, target, statusDrop)
        clearWorkspaceKanbanSidebarDropTargetVisual()
        setDragOverStatus(null)
        setPinDragOver(false)
        setWorktreeDragState((prev) =>
          prev.dropIndex === statusDrop.dropIndex &&
          prev.dropIndicatorY === statusDrop.dropIndicatorY &&
          prev.pointerY === drag.currentY &&
          areWorktreeDragPreviewOffsetsEqual(
            prev.previewOffsetsByWorktreeId,
            statusDrop.previewOffsetsByWorktreeId
          )
            ? prev
            : { ...prev, ...statusDrop, pointerY: drag.currentY }
        )
        return
      }
      updateLatestWorktreeStatusDropTarget(drag, target, statusDrop)
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
    drag.latestStatusDropTarget = null
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
    computeWorktreeStatusDrop,
    refreshWorktreeDragSession,
    shouldShowWorkspaceBoardDropIndicator,
    workspaceStatuses
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
        frameId: null,
        latestBoardDropTarget: null,
        latestStatusDropTarget: null
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
      const boardDropTarget = resolveWorkspaceKanbanCardDropCommitTarget({
        currentTarget: getWorkspaceKanbanSidebarDropTarget(event.clientX, event.clientY),
        latestTrackedTarget: drag.latestBoardDropTarget,
        x: event.clientX,
        y: event.clientY
      })
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
        const preferredStatusTarget = scrollRef.current
          ? getPointerDropStatusTarget({
              container: scrollRef.current,
              x: event.clientX,
              y: event.clientY
            })
          : { status: null, isPinDrop: false }
        if (
          shouldPreferSidebarStatusDropTarget({
            sourceGroupKey: drag.sourceGroupKey,
            target: preferredStatusTarget,
            workspaceStatuses
          })
        ) {
          const statusDrop = preferredStatusTarget.status
            ? computeWorktreeStatusDrop({
                pointerY: event.clientY,
                status: preferredStatusTarget.status,
                draggedIds: drag.draggedIds
              })
            : null
          if (preferredStatusTarget.isPinDrop) {
            onPinWorktrees(drag.draggedIds)
          } else if (preferredStatusTarget.status) {
            if (statusDrop) {
              onMoveWorktreesToStatusAtIndex({
                worktreeIds: drag.draggedIds,
                status: preferredStatusTarget.status,
                dropIndex: statusDrop.dropIndex,
                groups: worktreeDragGroups
              })
            } else {
              onMoveWorktreesToStatus(drag.draggedIds, preferredStatusTarget.status)
            }
          }
          clearWorktreeDrag()
          return
        }
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
          const currentTarget = preferredStatusTarget
          const currentPreview = currentTarget.status
            ? computeWorktreeStatusDrop({
                pointerY: event.clientY,
                status: currentTarget.status,
                draggedIds: drag.draggedIds
              })
            : null
          const { target, preview: statusDrop } = resolveWorktreeSidebarStatusDropCommitTarget({
            currentTarget,
            currentPreview,
            latestTrackedTarget: drag.latestStatusDropTarget,
            x: event.clientX,
            y: event.clientY
          })
          if (target.isPinDrop) {
            onPinWorktrees(drag.draggedIds)
          } else if (target.status) {
            if (statusDrop) {
              onMoveWorktreesToStatusAtIndex({
                worktreeIds: drag.draggedIds,
                status: target.status,
                dropIndex: statusDrop.dropIndex,
                groups: worktreeDragGroups
              })
            } else {
              onMoveWorktreesToStatus(drag.draggedIds, target.status)
            }
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
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatus,
    onMoveWorktreesToStatusAtIndex,
    onDropWorktreesOnWorkspaceBoard,
    onPinWorktrees,
    onReorderWorktrees,
    refreshWorktreeDragSession,
    scheduleWorktreePointerDragFrame,
    shouldShowWorkspaceBoardDropIndicator,
    worktreeDragGroups,
    worktreeDragUnitGroups,
    workspaceStatuses
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
          const target = getPointerDropStatusTarget({
            container,
            x: point.clientX,
            y: point.clientY
          })
          const statusDrop = target.status
            ? computeWorktreeStatusDrop({
                pointerY: point.clientY,
                status: target.status,
                draggedIds: session.draggedIds
              })
            : null
          if (statusDrop) {
            setWorktreeDragState((prev) =>
              prev.dropIndex === statusDrop.dropIndex &&
              prev.dropIndicatorY === statusDrop.dropIndicatorY &&
              areWorktreeDragPreviewOffsetsEqual(
                prev.previewOffsetsByWorktreeId,
                statusDrop.previewOffsetsByWorktreeId
              )
                ? prev
                : { ...prev, ...statusDrop, pointerY: point.clientY }
            )
            return
          }
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
      computeWorktreeStatusDrop,
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
        const target = getPointerDropStatusTarget({
          container: event.currentTarget,
          x: event.clientX,
          y: event.clientY
        })
        const statusDrop = target.status
          ? computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: session.draggedIds
            })
          : null
        if (statusDrop) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setWorktreeDragState((prev) =>
            prev.dropIndex === statusDrop.dropIndex &&
            prev.dropIndicatorY === statusDrop.dropIndicatorY &&
            areWorktreeDragPreviewOffsetsEqual(
              prev.previewOffsetsByWorktreeId,
              statusDrop.previewOffsetsByWorktreeId
            )
              ? prev
              : { ...prev, ...statusDrop, pointerY: event.clientY }
          )
          return
        }
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
      computeWorktreeStatusDrop,
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
        const container = scrollRef.current
        const target = container
          ? getPointerDropStatusTarget({
              container,
              x: event.clientX,
              y: event.clientY
            })
          : { status: null, isPinDrop: false }
        const statusDrop = target.status
          ? computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: session.draggedIds
            })
          : null
        if (target.status && statusDrop) {
          event.preventDefault()
          event.stopPropagation()
          onMoveWorktreesToStatusAtIndex({
            worktreeIds: session.draggedIds,
            status: target.status,
            dropIndex: statusDrop.dropIndex,
            groups: worktreeDragGroups
          })
          clearWorktreeDrag()
          return
        }
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
      computeWorktreeStatusDrop,
      onMoveWorktreesToStatusAtIndex,
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
    const currentWorktree = currentWorktreeId ? (worktreeMap.get(currentWorktreeId) ?? null) : null
    // Why: this visible reporter feeds the GitHub coordinator; GitLab-only MR
    // panels refresh through hosted-review paths instead.
    const sidebarWorktreeHasGitHubReview =
      currentWorktree !== null &&
      ((currentWorktree.linkedGitLabMR ?? null) === null ||
        (currentWorktree.linkedPR ?? null) !== null)
    const shouldTrackSidebarWorktree = rightSidebarShowsPR && sidebarWorktreeHasGitHubReview
    const shouldTrackVisibleRows =
      groupBy === 'pr-status' || cardProps.includes('pr') || cardProps.includes('ci')
    if (!shouldTrackVisibleRows && !shouldTrackSidebarWorktree) {
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
    const visibleWorktreeIds = new Set(visibleRows.map((row) => row.worktree.id))
    if (
      shouldTrackSidebarWorktree &&
      currentWorktree &&
      !currentWorktree.isBare &&
      currentWorktree.branch
    ) {
      visibleWorktreeIds.add(currentWorktree.id)
    }
    const visibleIdentity = visibleRows
      .map((row) => `${row.worktree.id}:${row.worktree.branch}:${row.worktree.linkedPR ?? ''}`)
      .join('|')
    const sidebarIdentity =
      shouldTrackSidebarWorktree && currentWorktree
        ? `${currentWorktree.id}:${currentWorktree.branch}:${currentWorktree.linkedPR ?? ''}`
        : ''
    const key = `${visibleIdentity}:${sidebarIdentity}:${sshConnectedGeneration}:${prVisibleRefreshGeneration}:${cardProps.join(',')}`
    if (!key || key === lastVisibleRefreshKeyRef.current) {
      return
    }
    lastVisibleRefreshKeyRef.current = key
    reportVisibleGitHubPRRefreshCandidates(Array.from(visibleWorktreeIds), Date.now())
  }, [
    cardProps,
    currentWorktreeId,
    documentVisibilityRevision,
    groupBy,
    renderRows,
    reportVisibleGitHubPRRefreshCandidates,
    prVisibleRefreshGeneration,
    rightSidebarShowsPR,
    sshConnectedGeneration,
    virtualItems,
    worktreeMap
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
      const session = worktreeDragSessionRef.current
      const statusDrop = session
        ? computeWorktreeStatusDrop({
            pointerY: event.clientY,
            status,
            draggedIds: session.draggedIds
          })
        : null
      setDragOverStatus(null)
      if (session && statusDrop) {
        event.stopPropagation()
        onMoveWorktreesToStatusAtIndex({
          worktreeIds: session.draggedIds,
          status,
          dropIndex: statusDrop.dropIndex,
          groups: worktreeDragGroups
        })
        clearWorktreeDrag()
        return
      }
      onMoveWorktreesToStatus(worktreeIds, status)
    },
    [
      clearWorktreeDrag,
      computeWorktreeStatusDrop,
      onMoveWorktreesToStatus,
      onMoveWorktreesToStatusAtIndex,
      worktreeDragGroups
    ]
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
        const container = scrollRef.current
        const target = container
          ? getPointerDropStatusTarget({
              container,
              x: event.clientX,
              y: event.clientY
            })
          : { status: null, isPinDrop: false }
        const statusDrop = target.status
          ? computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: session.draggedIds
            })
          : null
        if (target.status && statusDrop) {
          event.preventDefault()
          event.stopPropagation()
          onMoveWorktreesToStatusAtIndex({
            worktreeIds: session.draggedIds,
            status: target.status,
            dropIndex: statusDrop.dropIndex,
            groups: worktreeDragGroups
          })
          clearWorktreeDrag()
          return
        }
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
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatusAtIndex,
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
              // Why z-30 (not z-10): the sticky pinned header is z-20, so a
              // lower indicator renders behind it whenever the drop slot is at
              // the top while scrolled. Match the worktree indicator's tier.
              className="pointer-events-none absolute left-2 right-2 z-30 border-t border-dashed border-muted-foreground/70"
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
              <span className="size-1.5 shrink-0 rounded-full bg-worktree-sidebar-ring shadow-[0_0_0_2px_var(--worktree-sidebar)]" />
              <span className="h-0.5 flex-1 rounded-full bg-worktree-sidebar-ring shadow-[0_0_0_2px_var(--worktree-sidebar)]" />
              <span className="size-1.5 shrink-0 rounded-full bg-worktree-sidebar-ring shadow-[0_0_0_2px_var(--worktree-sidebar)]" />
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
              const repoHeaderIndex =
                projectIdForHeader !== undefined
                  ? repoHeaderIndexByRepoId.get(projectIdForHeader)
                  : undefined
              const repoHeaderBucketKey =
                projectIdForHeader !== undefined
                  ? repoHeaderBucketByRepoId.get(projectIdForHeader)
                  : undefined
              const isDraggableRepoHeader = Boolean(
                canReorderRepoHeaders &&
                isRepoHeader &&
                projectIdForHeader &&
                repoHeaderBucketKey &&
                (sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1
              )
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
              const projectGroupPathStatus =
                isProjectGroupHeader &&
                row.projectGroup &&
                'parentPath' in row.projectGroup &&
                row.projectGroup.parentPath
                  ? getCachedFolderWorkspacePathStatus({
                      scope: 'project-group',
                      projectGroupId: row.projectGroup.id
                    })
                  : null
              const folderWorkspaceCreateDisabled =
                projectGroupPathStatus?.exists === false &&
                (isConfirmedStaleFolderPathStatus(projectGroupPathStatus) ||
                  projectGroupPathStatus.reason === 'ambiguous-connection')
              const projectGroupDepth = row.projectGroupDepth ?? 0
              // Why: non-project section headers like "All" are labels for the
              // flat list, so they should not reserve project hierarchy indent.
              const headerPaddingLeft =
                isRepoHeader || isProjectGroupHeader
                  ? getProjectGroupHeaderPaddingLeft(projectGroupDepth)
                  : WORKTREE_SECTION_HEADER_PADDING_LEFT
              const isCollapsed = collapsedGroups.has(row.key)
              return (
                <div
                  key={vItem.key}
                  role="presentation"
                  data-worktree-virtual-row
                  data-worktree-virtual-row-key={String(vItem.key)}
                  data-worktree-sticky-header=""
                  data-worktree-sticky-header-active={isActiveStickyHeader ? '' : undefined}
                  data-worktree-virtual-row-start={vItem.start}
                  data-index={vItem.index}
                  ref={measureVirtualRowElement}
                  className={cn(
                    'left-0 right-0',
                    // Why: the inter-group spacer only applies while the header
                    // scrolls in normally; the pinned header drops it to sit
                    // flush at the top. The swap fires when the header row
                    // reaches the top (see getActiveStickyHeaderIndexForScroll),
                    // so the previous repo no longer stays pinned over it.
                    hasHeaderTopSpacing && !isActiveStickyHeader && 'pt-1',
                    isActiveStickyHeader
                      ? 'sticky -top-px z-20 bg-worktree-sidebar'
                      : 'absolute top-0'
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
                    data-repo-header-index={repoHeaderIndex}
                    data-repo-header-bucket={repoHeaderBucketKey}
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
                        'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/40',
                      isPinnedHeader &&
                        pinDragOver &&
                        'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/40',
                      row.repo && 'overflow-hidden'
                    )}
                    style={{ paddingLeft: headerPaddingLeft }}
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
                    onClick={(event) => {
                      if (shouldIgnoreRepoHeaderToggle(event)) {
                        return
                      }
                      toggleGroupWithScrollAnchor(row.key)
                    }}
                    onKeyDown={(e) => {
                      if (shouldIgnoreRepoHeaderToggle(e)) {
                        return
                      }
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleGroupWithScrollAnchor(row.key)
                      }
                    }}
                  >
                    {row.icon ? (
                      <div
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
                        <div
                          data-repo-header-drag-handle=""
                          className={cn(
                            'min-w-0 truncate text-[13px] font-semibold leading-none',
                            isDraggableRepoHeader && 'cursor-grab'
                          )}
                          onPointerDown={
                            isDraggableRepoHeader && projectIdForHeader
                              ? (event) => repoDrag.onHandlePointerDown(event, projectIdForHeader)
                              : undefined
                          }
                        >
                          {row.label}
                        </div>
                        <RepoForkIndicator upstream={row.repo?.upstream} />
                        <FolderPathStatusIndicator status={projectGroupPathStatus} />
                        <SectionMetricsBadge count={row.count} />
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
                            data-repo-header-action=""
                            className="size-5 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                            aria-label={translate(
                              'auto.components.sidebar.WorktreeList.79465e9034',
                              'Group actions for {{value0}}',
                              { value0: row.label }
                            )}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={stopRepoHeaderKeyboardToggle}
                            onPointerDown={handleRepoHeaderActionPointerDown}
                          >
                            <Ellipsis className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          side="bottom"
                          sideOffset={6}
                          // Why: Radix portals preserve React bubbling through
                          // the project header. Keep menu interactions from
                          // arming row drag/collapse handlers behind it.
                          onPointerDown={stopRepoHeaderMenuEvent}
                          onMouseDown={stopRepoHeaderMenuEvent}
                          onPointerUp={stopRepoHeaderMenuEvent}
                          onMouseUp={stopRepoHeaderMenuEvent}
                          onClick={stopRepoHeaderMenuEvent}
                          onKeyDown={stopRepoHeaderMenuEvent}
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              if (row.projectGroup?.id) {
                                handleRenameProjectGroup(row.projectGroup.id, row.label)
                              }
                            }}
                          >
                            {translate(
                              'auto.components.sidebar.WorktreeList.4d7b73658c',
                              'Rename group'
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => {
                              if (row.projectGroup?.id) {
                                handleDeleteProjectGroup(row.projectGroup.id, row.label)
                              }
                            }}
                          >
                            {translate(
                              'auto.components.sidebar.WorktreeList.902115cdbe',
                              'Delete group'
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}

                    {isProjectGroupHeader &&
                    !row.repo &&
                    row.projectGroup &&
                    'parentPath' in row.projectGroup &&
                    row.projectGroup.parentPath ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            data-repo-header-action=""
                            className={cn(
                              'size-5 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground focus:opacity-100 group-hover:opacity-100',
                              folderWorkspaceCreateDisabled &&
                                'cursor-not-allowed text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60'
                            )}
                            aria-label={translate(
                              'auto.components.sidebar.WorktreeList.bd37a57ac8',
                              'Create workspace for {{value0}}',
                              { value0: row.label }
                            )}
                            aria-disabled={folderWorkspaceCreateDisabled}
                            onKeyDown={stopRepoHeaderKeyboardToggle}
                            onPointerDown={handleRepoHeaderActionPointerDown}
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              if (folderWorkspaceCreateDisabled) {
                                return
                              }
                              if (
                                row.projectGroup &&
                                'parentPath' in row.projectGroup &&
                                row.projectGroup.parentPath
                              ) {
                                handleCreateFolderWorkspace(row.projectGroup)
                              }
                            }}
                          >
                            <Plus className="size-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          {projectGroupPathStatus?.exists === false
                            ? getFolderWorkspacePathStatusDescription(projectGroupPathStatus)
                            : translate(
                                'auto.components.sidebar.WorktreeList.bd37a57ac8',
                                'Create workspace for {{value0}}',
                                { value0: row.label }
                              )}
                        </TooltipContent>
                      </Tooltip>
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
                                data-repo-header-action=""
                                className="size-5 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                                aria-label={translate(
                                  'auto.components.sidebar.WorktreeList.609633a9e6',
                                  'Project actions for {{value0}}',
                                  { value0: row.label }
                                )}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={stopRepoHeaderKeyboardToggle}
                                onPointerDown={handleRepoHeaderActionPointerDown}
                              >
                                <Ellipsis className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {translate(
                              'auto.components.sidebar.WorktreeList.2ef41bf9a7',
                              'Project actions'
                            )}
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent
                          align="end"
                          side="bottom"
                          sideOffset={6}
                          // Why: Radix portals preserve React bubbling through
                          // the project header. Keep menu interactions from
                          // arming row drag/collapse handlers behind it.
                          onPointerDown={stopRepoHeaderMenuEvent}
                          onMouseDown={stopRepoHeaderMenuEvent}
                          onPointerUp={stopRepoHeaderMenuEvent}
                          onMouseUp={stopRepoHeaderMenuEvent}
                          onClick={stopRepoHeaderMenuEvent}
                          onKeyDown={stopRepoHeaderMenuEvent}
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              if (row.repo) {
                                handleOpenRepoSettings(row.repo.id)
                              }
                            }}
                          >
                            <SlidersHorizontal className="size-3.5" />
                            {translate(
                              'auto.components.sidebar.WorktreeList.2cdffbc728',
                              'Project Settings'
                            )}
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
                            {translate(
                              'auto.components.sidebar.WorktreeList.e82d3589a1',
                              'Change Project Icon'
                            )}
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
                            {translate(
                              'auto.components.sidebar.WorktreeList.cbfd565f83',
                              'New group from project'
                            )}
                          </DropdownMenuItem>
                          {projectGroups.length > 0 ? (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <FolderInput className="size-3.5" />
                                {translate(
                                  'auto.components.sidebar.WorktreeList.4a08fb55f2',
                                  'Move to group'
                                )}
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
                              {translate(
                                'auto.components.sidebar.WorktreeList.64e55f7f01',
                                'Remove from group'
                              )}
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
                            {translate(
                              'auto.components.sidebar.WorktreeList.c83968f87f',
                              'Remove Project'
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}

                    {row.repo && groupBy === 'repo' ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {createState?.disabled ? (
                            <span
                              data-repo-header-action=""
                              className="inline-flex cursor-not-allowed opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                              tabIndex={0}
                              aria-label={createState.ariaLabel}
                              onKeyDown={stopRepoHeaderKeyboardToggle}
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={handleRepoHeaderActionPointerDown}
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
                              data-repo-header-action=""
                              className="size-5 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                              aria-label={
                                createState?.ariaLabel ??
                                translate(
                                  'auto.components.sidebar.WorktreeList.bb85cd86ba',
                                  'Create workspace for {{value0}}',
                                  { value0: row.label }
                                )
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
                          {createState?.tooltip ??
                            translate(
                              'auto.components.sidebar.WorktreeList.bb85cd86ba',
                              'Create workspace for {{value0}}',
                              { value0: row.label }
                            )}
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
              // Why: child card rows own lineage depth, while WorktreeCard
              // still owns the project/group inset inside each card surface.
              const paddingDepth = nested ? Math.max(0, itemRow.depth - 1) : itemRow.depth
              const nestedCardPaddingLeft = nested
                ? getWorktreeCardSurfaceInset({
                    isGrouped: true,
                    groupDepth: itemRow.depth
                  })
                : 0
              const inheritedCardContentIndent = getWorktreeCardContentIndent({
                isGrouped: groupBy !== 'none',
                groupDepth: itemRow.groupDepth,
                lineageDepth: 0
              })
              // Why: grouped rows inherit their project/group header depth,
              // while the card surface still spans the full hit/background row.
              const paddingLeft = getWorktreeCardContentIndent({
                isGrouped: !nested && groupBy !== 'none',
                groupDepth: itemRow.groupDepth,
                lineageDepth: paddingDepth
              })
              const surfaceInset = nested
                ? nestedCardPaddingLeft
                : getWorktreeCardSurfaceInset({
                    isGrouped: groupBy !== 'none',
                    groupDepth: itemRow.groupDepth
                  })
              const cardContentIndent = Math.max(
                0,
                (nested ? inheritedCardContentIndent : paddingLeft) - surfaceInset
              )
              const worktreeDragGroupKey = groupKeyByWorktreeId.get(itemRow.worktree.id)
              const worktreeDragGroupIndex = groupIndexByWorktreeId.get(itemRow.worktree.id)
              const revealHighlightTone =
                agentSendTargetWorktreeId === itemRow.worktree.id ? 'ai' : 'default'
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
                    paddingLeft: surfaceInset > 0 ? `${surfaceInset}px` : undefined
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
                    revealHighlight={highlightedRevealWorktreeId === itemRow.worktree.id}
                    revealHighlightTone={revealHighlightTone}
                    selectedWorktrees={selectedWorktrees}
                    nativeDragEnabled={false}
                    contentIndent={cardContentIndent}
                    flushSurface
                    onImmediateActivate={onImmediateWorktreeActivate}
                    onSelectionGesture={onSelectionGesture}
                    onContextMenuSelect={onContextMenuSelect}
                    onCardDragStart={handleWorktreeCardDragStart}
                    onCardDragEnd={clearWorktreeDrag}
                    hideRepoBadge={groupBy === 'repo'}
                    // Why: pinned worktrees only render in the Pinned group, so
                    // isPinned marks the mixed-repo pinned section that needs icons.
                    inPinnedSection={itemRow.worktree.isPinned}
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
                  <ImportedWorktreesVisibilityLine
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

            if (row.type === 'pending-creation') {
              return (
                <div
                  key={vItem.key}
                  role="presentation"
                  data-worktree-virtual-row
                  data-worktree-virtual-row-key={String(vItem.key)}
                  data-worktree-virtual-row-start={vItem.start}
                  data-index={vItem.index}
                  ref={measureVirtualRowElement}
                  className="absolute left-0 right-0 top-0 px-2 pb-1.5"
                  style={{ transform: getVirtualRowTransform(vItem.start) }}
                >
                  <PendingWorktreeRow creationId={row.creationId} />
                </div>
              )
            }

            if (row.type === 'folder-workspace') {
              const folderWorkspaceRow = row as FolderWorkspaceItemRow
              const folderWorktree = folderWorkspaceToWorktree(folderWorkspaceRow.folderWorkspace)
              const folderWorkspacePathStatus = getCachedFolderWorkspacePathStatus({
                scope: 'folder-workspace',
                folderWorkspaceId: folderWorkspaceRow.folderWorkspace.id
              })
              const folderWorkspaceActivationDisabled =
                folderWorkspacePathStatus?.exists === false &&
                (isConfirmedStaleFolderPathStatus(folderWorkspacePathStatus) ||
                  folderWorkspacePathStatus.reason === 'ambiguous-connection')
              const contentIndent = getWorktreeCardContentIndent({
                isGrouped: groupBy !== 'none',
                groupDepth: folderWorkspaceRow.groupDepth,
                lineageDepth: folderWorkspaceRow.depth
              })
              // Why: folder workspace surfaces should step inward with their
              // project-group nesting, matching lineage child card surfaces
              // instead of spanning from the sidebar edge at every depth.
              const surfaceInset = getWorktreeCardSurfaceInset({
                isGrouped: groupBy !== 'none',
                groupDepth: folderWorkspaceRow.groupDepth
              })
              const insetContentIndent = Math.max(0, contentIndent - surfaceInset)
              return (
                <div
                  key={vItem.key}
                  id={getWorktreeOptionId(folderWorktree.id)}
                  role="option"
                  aria-selected={selectedWorktreeIds.has(folderWorktree.id)}
                  aria-current={activeWorktreeId === folderWorktree.id ? 'page' : undefined}
                  data-worktree-virtual-row
                  data-worktree-virtual-row-key={String(vItem.key)}
                  data-worktree-virtual-row-start={vItem.start}
                  data-index={vItem.index}
                  ref={measureVirtualRowElement}
                  className="absolute left-0 right-0 top-0"
                  style={{ transform: getVirtualRowTransform(vItem.start) }}
                  onClickCapture={handleWorktreeRowClickCapture}
                  onPointerDown={(event) => handleWorktreeRowPointerDown(event, folderWorktree.id)}
                >
                  <div
                    className="relative"
                    style={surfaceInset > 0 ? { paddingLeft: surfaceInset } : undefined}
                  >
                    <WorktreeCard
                      worktree={folderWorktree}
                      repo={undefined}
                      isActive={activeWorktreeId === folderWorktree.id}
                      isCurrentWorktree={currentWorktreeId === folderWorktree.id}
                      contentIndent={insetContentIndent}
                      flushSurface
                      nativeDragEnabled={false}
                      onImmediateActivate={
                        folderWorkspaceActivationDisabled ? undefined : onImmediateWorktreeActivate
                      }
                      onSelectionGesture={onSelectionGesture}
                      onContextMenuSelect={onContextMenuSelect}
                    />
                    <div className="pointer-events-auto absolute right-3 top-1.5">
                      <FolderPathStatusIndicator status={folderWorkspacePathStatus} />
                    </div>
                  </div>
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
  const currentSidebarWorktreeId = activeWorktreeId
  const groupBy = useAppStore((s) => s.groupBy)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
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
  const setWorktreesPinnedAndReveal = useAppStore((s) => s.setWorktreesPinnedAndReveal)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)
  const agentSendPopoverTargetMode = useAppStore((s) => s.agentSendPopoverTargetMode)
  // Why: agent-send eligibility only matters while the picker is open. When it
  // is closed, avoid subscribing WorktreeList to wake-time terminal layout churn.
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
  const agentSendTargetWorktreeId = useMemo(() => {
    void agentTargetStatusEpoch
    if (!agentSendPopoverTargetMode) {
      return null
    }
    const targets = deriveRunningAgentSendTargets(
      {
        agentStatusByPaneKey: agentTargetStatusByPaneKey,
        tabsByWorktree: agentTargetTabsByWorktree,
        terminalLayoutsByTabId: agentTargetTerminalLayoutsByTabId
      },
      agentSendPopoverTargetMode.worktreeId
    )
    return targets.some((target) => target.status === 'eligible')
      ? agentSendPopoverTargetMode.worktreeId
      : null
  }, [
    // Why: eligibility can flip when the stale-boundary scheduler bumps this
    // epoch without replacing the status map.
    agentTargetStatusEpoch,
    agentSendPopoverTargetMode,
    agentTargetStatusByPaneKey,
    agentTargetTabsByWorktree,
    agentTargetTerminalLayoutsByTabId
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

  // PR cache is needed for PR-status grouping and when the PR card property
  // is visible.
  const prCache = useAppStore((s) =>
    groupBy === 'pr-status' || cardProps.includes('pr') ? s.prCache : null
  )
  const settings = useAppStore((s) => s.settings)

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
    if (
      agentSendTargetWorktreeId &&
      !ids.includes(agentSendTargetWorktreeId) &&
      worktreeMap.has(agentSendTargetWorktreeId)
    ) {
      // Why: send-target mode is a temporary picker overlay on the current
      // sidebar. Make the target card reachable without rewriting the user's
      // filters; closing the popover naturally restores the filtered view.
      ids.push(agentSendTargetWorktreeId)
    }
    return ids.map((id) => worktreeMap.get(id)).filter((w): w is Worktree => w != null)
  }, [
    agentSendTargetWorktreeId,
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
        projectGroups
      )) {
        next.delete(groupKey)
      }
    }

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
      next.delete(getLineageGroupKey(parent.id))
      current = parent
    }
    return next
  }, [
    agentSendTargetWorktreeId,
    collapsedGroups,
    groupBy,
    prCache,
    projectGroups,
    repoMap,
    settings,
    workspaceStatuses,
    worktreeLineageById,
    worktreeMap
  ])
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
    return getEmptyProjectPlaceholderRepoIds({ groupBy, repos, worktreesByRepo, filterRepoIds })
  }, [filterRepoIds, groupBy, repos, worktreesByRepo])
  const allRepoIds = useMemo(() => repos.map((r) => r.id), [repos])

  // Why: buildRows only needs which creates exist and their repo. Subscribe on a
  // flat key array (value-compared by useShallow) so progress updates
  // (phase/loaderVisible) don't churn it and rebuild the whole sidebar row model
  // on every creation tick. Split on the first space — the creationId is a UUID,
  // so it has none and the repoId (which may contain spaces) stays intact.
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

  // Build flat row list for rendering
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
        projectGroups,
        placeholderRepoIds,
        importedWorktreesByRepo,
        pendingCreations,
        folderWorkspaces
      ),
    [
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
      settings,
      projectGroups,
      placeholderRepoIds,
      importedWorktreesByRepo,
      pendingCreations,
      folderWorkspaces
    ]
  )
  // Why: status headers change during wake (inactive -> active). Key only on
  // the grouping mode so row identity survives those ordinary status moves.
  const viewportResetKey = `group:${groupBy}:lineage`

  // Why: derive the rendered item order from the post-buildRows() row list,
  // not the flat `worktrees` array, because grouping (groupBy: 'repo' or
  // 'pr-status') can reorder cards into grouped sections. Using the flat
  // order would cause Cmd+1–9 shortcuts to not match the visual card
  // positions when grouping is active.
  const renderedWorktrees = useMemo(
    () =>
      rows.flatMap((row) => {
        if (row.type === 'item') {
          return [row.worktree]
        }
        if (row.type === 'folder-workspace') {
          return [folderWorkspaceToWorktree(row.folderWorkspace)]
        }
        return []
      }),
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

  const handleImmediateWorktreeActivate = useCallback((worktreeId: string) => {
    // Why: React-rendering the full virtualized sidebar on the pointer path is
    // visible latency. Mutate only the selected-row affordance; store state
    // reconciles the same attributes after activation settles.
    markSidebarWorktreeActiveImmediately(worktreeId)
  }, [])

  // Why: full-page navigation views are not scoped to one worktree, so no
  // sidebar card should appear selected while one of them is active.
  const selectedSidebarWorktreeId =
    activeView === 'tasks' || activeView === 'activity' ? null : currentSidebarWorktreeId

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
  const deleteProjectGroupWithContainedProjects = useAppStore(
    (s) => s.deleteProjectGroupWithContainedProjects
  )
  const [projectGroupNameDialog, setProjectGroupNameDialog] =
    useState<ProjectGroupNameDialogState | null>(null)
  const [projectGroupDeleteDialog, setProjectGroupDeleteDialog] =
    useState<ProjectGroupDeleteDialogState | null>(null)
  const [folderWorkspaceCreateGroup, setFolderWorkspaceCreateGroup] = useState<ProjectGroup | null>(
    null
  )

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
      // Why: a missing group is already in the desired end state, so close
      // quietly; only a real delete failure warrants an error toast.
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
      // Why: deleting contained projects can empty the sidebar and unmount this
      // dialog before its own close handler runs, so the parent owns cleanup.
      setProjectGroupDeleteDialog(null)
    }
  }, [
    deleteProjectGroupWithContainedProjects,
    projectGroupRemoveContainedProjects,
    projectGroupDeleteDialog
  ])

  const handleCreateFolderWorkspace = useCallback((projectGroup: ProjectGroup) => {
    if (!projectGroup.parentPath) {
      return
    }
    setFolderWorkspaceCreateGroup(projectGroup)
  }, [])

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
      // Why: showing an insertion line promises exact placement, so a
      // cross-status sidebar drop must persist manual order for that section.
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

  const handleRevealCurrentWorkspaceRequest = useCallback(
    (event: Event) => {
      const detail =
        event instanceof CustomEvent
          ? (event.detail as ScrollToCurrentWorkspaceRevealRequestDetail | undefined)
          : undefined
      if (!activeWorktreeId) {
        return
      }
      const activeWorktree = getKnownSidebarWorktreeById(
        activeWorktreeId,
        worktreeMap,
        folderWorkspaces
      )
      if (!activeWorktree || activeWorktree.isArchived) {
        return
      }
      if (!renderedWorktreeIds.includes(activeWorktreeId)) {
        // Why: the toolbar action promises to reveal the current workspace; when
        // sidebar filters hide it, relax those filters before queuing the reveal.
        clearFilters()
      }
      revealWorktreeInSidebar(activeWorktreeId, {
        behavior: 'smooth',
        highlight: true,
        beginRename: detail?.beginRename === true
      })
    },
    [
      activeWorktreeId,
      clearFilters,
      folderWorkspaces,
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
  // Why: Project Group headers can render before workspace rows load, but when
  // active filters hide everything the Clear Filters empty state must win.
  if (rows.length === 0 || filtersHideAllRows) {
    return (
      <div
        data-worktree-sidebar-container
        data-contextual-tour-target="workspace-list"
        className="relative min-h-0 flex-1"
      >
        <div className="worktree-sidebar-scrollbar flex h-full flex-col overflow-y-scroll overflow-x-hidden pl-1 scrollbar-sleek pt-px">
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
      <FolderWorkspaceComposerDialog
        open={folderWorkspaceCreateGroup !== null}
        projectGroup={folderWorkspaceCreateGroup}
        onOpenChange={(open) => {
          if (!open) {
            setFolderWorkspaceCreateGroup(null)
          }
        }}
      />
      <VirtualizedWorktreeViewport
        key={viewportResetKey}
        rows={rows}
        activeWorktreeId={selectedSidebarWorktreeId}
        currentWorktreeId={currentSidebarWorktreeId}
        groupBy={groupBy}
        projectOrderBy={projectOrderBy}
        toggleGroup={toggleGroup}
        collapsedGroups={effectiveCollapsedGroups}
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
        handleCreateFolderWorkspace={handleCreateFolderWorkspace}
        activeModal={activeModal}
        pendingRevealWorktree={pendingRevealWorktree}
        clearPendingRevealWorktreeId={clearPendingRevealWorktreeId}
        agentSendTargetWorktreeId={agentSendTargetWorktreeId}
        worktrees={worktrees}
        folderWorkspaces={folderWorkspaces}
        selectedWorktreeIds={selectedWorktreeIds}
        selectedWorktrees={selectedWorktrees}
        onSelectionGesture={updateSelectionForGesture}
        onImmediateWorktreeActivate={handleImmediateWorktreeActivate}
        onContextMenuSelect={selectForContextMenu}
        repoMap={repoMap}
        worktreeMap={worktreeMap}
        worktreeLineageById={worktreeLineageById}
        repoOrder={repoOrder}
        allRepoIds={allRepoIds}
        prCache={prCache}
        workspaceStatuses={workspaceStatuses}
        projectGroups={projectGroups}
        onMoveWorktreeToStatus={moveWorktreeToStatus}
        onMoveWorktreesToStatus={moveWorktreesToStatus}
        onMoveWorktreesToStatusAtIndex={moveWorktreesToStatusAtIndex}
        onPinWorktree={pinWorktree}
        onPinWorktrees={pinWorktrees}
        onDropWorktreesOnWorkspaceBoard={dropWorktreesOnWorkspaceBoard}
        shouldShowWorkspaceBoardDropIndicator={shouldShowWorkspaceBoardDropIndicator}
        onReorderWorktrees={reorderWorktrees}
        scrollOffsetRef={scrollOffsetRef}
        scrollAnchorRef={scrollAnchorRef}
      />
    </>
  )
})

export default WorktreeList
