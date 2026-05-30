import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree,
  WorktreeMeta
} from '../../../../shared/types'
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

const BOARD_SELECTOR = '[data-workspace-board-selection-surface]'
const EXTERNAL_DRAG_TARGET_ATTR = 'data-workspace-board-external-drag-target'

let externalDragTargetElement: HTMLElement | null = null

function getWorkspaceKanbanBoardElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(BOARD_SELECTOR)
}

export function hasWorkspaceKanbanSidebarDropBoard(): boolean {
  return getWorkspaceKanbanBoardElement() !== null
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

export function getWorkspaceKanbanSidebarDropGroups(): WorktreeDragGroup[] {
  const board = getWorkspaceKanbanBoardElement()
  if (!board) {
    return []
  }

  return Array.from(board.querySelectorAll<HTMLElement>(STATUS_DROP_TARGET)).flatMap((lane) => {
    const status = lane.dataset.workspaceStatus
    if (!status) {
      return []
    }
    return [
      {
        key: status,
        worktreeIds: Array.from(lane.querySelectorAll<HTMLElement>(CARD_SELECTOR)).flatMap(
          (card) => card.dataset.workspaceBoardCardId ?? []
        )
      }
    ]
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
