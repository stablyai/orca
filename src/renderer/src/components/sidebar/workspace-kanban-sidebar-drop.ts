import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree,
  WorktreeMeta
} from '../../../../shared/types'
import {
  parseWorkspaceLaneFullIds,
  resolveFullLaneDropIndex
} from './workspace-kanban-filtered-drop-index'
import { getWorkspaceStatus } from './workspace-status'
import {
  buildManualOrderUpdatesForGroupDrop,
  shouldWriteManualOrderForGroupDrop,
  type WorktreeDragGroup
} from './worktree-manual-order'
import {
  CARD_SELECTOR,
  getCardDropTarget,
  PIN_DROP_TARGET,
  removeCardDropIndicator,
  STATUS_DROP_TARGET,
  updateCardDropIndicator,
  type WorkspaceKanbanCardDropTarget
} from './workspace-kanban-card-pointer-drag-dom'
import { getWorkspaceKanbanVirtualLaneItemIds } from './workspace-kanban-virtual-lane-layout'

const BOARD_SELECTOR = '[data-workspace-board-selection-surface]'
const BOARD_SHEET_SELECTOR = '[data-workspace-board-sheet]'
const LANE_SCROLL_SELECTOR = '[data-workspace-board-lane-scroll]'
const EXTERNAL_DRAG_TARGET_ATTR = 'data-workspace-board-external-drag-target'

let externalDragTargetElement: HTMLElement | null = null
let logicalDropGroupsRegistration: { groups: readonly WorktreeDragGroup[] } | null = null

function getWorkspaceKanbanBoardElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(BOARD_SELECTOR)
}

export function hasWorkspaceKanbanSidebarDropBoard(): boolean {
  return getWorkspaceKanbanBoardElement() !== null
}

export function isWorkspaceKanbanSidebarDropPointInBoard(x: number, y: number): boolean {
  const board = getWorkspaceKanbanBoardElement()
  if (!board) {
    return false
  }
  const hitSurface = board.closest<HTMLElement>(BOARD_SHEET_SELECTOR) ?? board
  const rect = hitSurface.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function getLaneCardIds(lane: HTMLElement): HTMLElement[] {
  return Array.from(lane.querySelectorAll<HTMLElement>(CARD_SELECTOR))
}

/**
 * `viewIds` is the lane in the index space `getCardDropTarget` reports, and
 * `fullLaneIds` is the lane's whole membership. Board search hides non-matching
 * cards, so lanes publish their full membership for exactly this reader.
 *
 * Why the virtual layout first: lanes virtualize, so the mounted cards are a
 * window rather than the lane view, and `getCardDropTarget` indexes the same
 * virtual layout. The DOM scan is only the fallback for a lane the virtualizer
 * never claimed — there the unfiltered card list is the full lane, since a card
 * the browser is not laying out is still a member for manual-order purposes.
 */
function toLaneDropIds(lane: HTMLElement): { fullLaneIds: string[]; viewIds: string[] } {
  const publishedFullLaneIds = parseWorkspaceLaneFullIds(lane.dataset.workspaceLaneFullIds)
  const laneScroll = lane.querySelector<HTMLElement>(LANE_SCROLL_SELECTOR)
  const virtualItemIds = laneScroll ? getWorkspaceKanbanVirtualLaneItemIds(laneScroll) : null
  if (virtualItemIds) {
    const viewIds = [...virtualItemIds]
    return { fullLaneIds: publishedFullLaneIds ?? viewIds, viewIds }
  }
  const cards = getLaneCardIds(lane)
  return {
    fullLaneIds:
      publishedFullLaneIds ?? cards.flatMap((card) => card.dataset.workspaceBoardCardId ?? []),
    viewIds: cards
      .filter((card) => card.offsetParent !== null)
      .flatMap((card) => card.dataset.workspaceBoardCardId ?? [])
  }
}

function getStatusDropTargetElement(
  board: HTMLElement,
  status: WorkspaceStatus
): HTMLElement | null {
  return (
    Array.from(board.querySelectorAll<HTMLElement>(STATUS_DROP_TARGET)).find(
      (element) => element.dataset.workspaceStatus === status
    ) ?? null
  )
}

function setExternalDragTargetElement(element: HTMLElement | null): void {
  if (externalDragTargetElement === element) {
    return
  }
  externalDragTargetElement?.removeAttribute(EXTERNAL_DRAG_TARGET_ATTR)
  externalDragTargetElement = element
  externalDragTargetElement?.setAttribute(EXTERNAL_DRAG_TARGET_ATTR, 'true')
}

export function clearWorkspaceKanbanSidebarDropTargetVisual(): void {
  setExternalDragTargetElement(null)
  removeCardDropIndicator()
}

export function registerWorkspaceKanbanSidebarDropGroups(
  groups: readonly WorktreeDragGroup[]
): () => void {
  const registration = { groups }
  logicalDropGroupsRegistration = registration
  return () => {
    if (logicalDropGroupsRegistration === registration) {
      logicalDropGroupsRegistration = null
    }
  }
}

export function getWorkspaceKanbanSidebarDropGroups(): WorktreeDragGroup[] {
  if (logicalDropGroupsRegistration) {
    return logicalDropGroupsRegistration.groups.map((group) => ({
      key: group.key,
      worktreeIds: [...group.worktreeIds]
    }))
  }

  const board = getWorkspaceKanbanBoardElement()
  if (!board) {
    return []
  }

  return Array.from(board.querySelectorAll<HTMLElement>(STATUS_DROP_TARGET)).flatMap((lane) => {
    const status = lane.dataset.workspaceStatus
    if (!status) {
      return []
    }
    return [{ key: status, worktreeIds: toLaneDropIds(lane).fullLaneIds }]
  })
}

export function getWorkspaceKanbanSidebarDropTarget(
  x: number,
  y: number
): WorkspaceKanbanCardDropTarget {
  const board = getWorkspaceKanbanBoardElement()
  if (!board) {
    return { status: null, isPinDrop: false, dropIndex: 0 }
  }
  return getCardDropTarget(board, x, y)
}

/**
 * Translates a tracked drop index — which counts the lane's *view* items,
 * matching the drop indicator — onto the full lane that
 * `getWorkspaceKanbanSidebarDropGroups` reports. Call this once, at the commit
 * boundary: a tracked target can be committed after the pointer has left the
 * lane, so translating earlier would miss that path.
 */
export function resolveWorkspaceKanbanSidebarFullLaneDropIndex(
  status: WorkspaceStatus,
  viewDropIndex: number
): number {
  const board = getWorkspaceKanbanBoardElement()
  const lane = board ? getStatusDropTargetElement(board, status) : null
  if (!lane) {
    return viewDropIndex
  }
  const { fullLaneIds, viewIds } = toLaneDropIds(lane)
  return resolveFullLaneDropIndex({
    fullLaneIds,
    renderedIds: viewIds,
    filteredDropIndex: viewDropIndex
  })
}

export function updateWorkspaceKanbanSidebarDropTargetVisual(args: {
  x: number
  y: number
  shouldShowDropIndicator: (target: WorkspaceKanbanCardDropTarget) => boolean
}): WorkspaceKanbanCardDropTarget {
  const board = getWorkspaceKanbanBoardElement()
  if (!board) {
    clearWorkspaceKanbanSidebarDropTargetVisual()
    return { status: null, isPinDrop: false, dropIndex: 0 }
  }

  const target = getCardDropTarget(board, args.x, args.y)
  const targetElement = target.isPinDrop
    ? board.querySelector<HTMLElement>(PIN_DROP_TARGET)
    : target.status
      ? getStatusDropTargetElement(board, target.status)
      : null
  setExternalDragTargetElement(targetElement)

  if (target.status && args.shouldShowDropIndicator(target)) {
    updateCardDropIndicator(board, target)
  } else {
    removeCardDropIndicator()
  }

  return target
}

export function buildWorkspaceKanbanSidebarDropUpdates(args: {
  worktreeIds: readonly string[]
  status: WorkspaceStatus
  dropIndex: number
  groups: readonly WorktreeDragGroup[]
  worktreeById: ReadonlyMap<string, Worktree>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  sortBy: string
  now: number
}): {
  updates: Map<string, Partial<WorktreeMeta>>
  shouldSwitchToManual: boolean
} {
  const sourceGroupKeys = args.worktreeIds.flatMap((worktreeId) => {
    const worktree = args.worktreeById.get(worktreeId)
    return worktree ? [getWorkspaceStatus(worktree, args.workspaceStatuses)] : []
  })
  const writeManualOrder = shouldWriteManualOrderForGroupDrop({
    sortBy: args.sortBy,
    sourceGroupKeys,
    targetGroupKey: args.status
  })
  const rankByWorktreeId = writeManualOrder
    ? (() => {
        const ranks = new Map<string, number>()
        for (const group of args.groups) {
          for (const worktreeId of group.worktreeIds) {
            const worktree = args.worktreeById.get(worktreeId)
            if (worktree) {
              ranks.set(worktreeId, worktree.manualOrder ?? worktree.sortOrder)
            }
          }
        }
        return ranks
      })()
    : undefined
  const order = writeManualOrder
    ? buildManualOrderUpdatesForGroupDrop({
        groups: args.groups,
        targetGroupKey: args.status,
        draggedIds: args.worktreeIds,
        dropIndex: args.dropIndex,
        now: args.now,
        rankByWorktreeId
      })
    : { changed: false, updates: new Map<string, { manualOrder: number }>() }

  const updates = new Map<string, Partial<WorktreeMeta>>()
  for (const worktreeId of args.worktreeIds) {
    const current = args.worktreeById.get(worktreeId)
    if (!current) {
      continue
    }
    if (getWorkspaceStatus(current, args.workspaceStatuses) !== args.status) {
      updates.set(worktreeId, { workspaceStatus: args.status })
    }
  }

  if (writeManualOrder) {
    for (const [worktreeId, manualOrder] of order.updates) {
      updates.set(worktreeId, { ...updates.get(worktreeId), ...manualOrder })
    }
  }

  return {
    updates,
    shouldSwitchToManual: writeManualOrder && order.changed
  }
}
