import type { WorkspaceStatus } from '../../../../shared/types'

export const CARD_SELECTOR = '[data-workspace-board-card-id]'
export const STATUS_DROP_TARGET = '[data-workspace-status-drop-target]'
export const PIN_DROP_TARGET = '[data-workspace-pin-drop-target]'

const STATUS_DROP_GAP_TOLERANCE_PX = 24
const POINTER_DROP_INDICATOR_ATTR = 'data-workspace-board-card-drop-indicator'
const COMMIT_TARGET_FALLBACK_TOLERANCE_PX = 6

export type WorkspaceKanbanStatusDropRect = {
  status: WorkspaceStatus
  left: number
  top: number
  right: number
  bottom: number
}

export type WorkspaceKanbanCardDropRect = {
  top: number
  bottom: number
}

export type WorkspaceKanbanLaneDropRect = {
  left: number
  top: number
  width: number
}

export type WorkspaceKanbanCardDropTarget = {
  status: WorkspaceStatus | null
  isPinDrop: boolean
  dropIndex: number
  laneRect?: WorkspaceKanbanLaneDropRect
  cardRects?: readonly WorkspaceKanbanCardDropRect[]
}

export type WorkspaceKanbanCardTrackedDropTarget = {
  target: WorkspaceKanbanCardDropTarget
  x: number
  y: number
}

export function resolveWorkspaceStatusDropTargetFromRects(
  rects: readonly WorkspaceKanbanStatusDropRect[],
  x: number,
  y: number,
  gapTolerance = STATUS_DROP_GAP_TOLERANCE_PX
): WorkspaceStatus | null {
  let nearest: { status: WorkspaceStatus; distance: number } | null = null

  for (const rect of rects) {
    if (y < rect.top || y > rect.bottom) {
      continue
    }
    if (x >= rect.left && x <= rect.right) {
      return rect.status
    }
    const distance = x < rect.left ? rect.left - x : x - rect.right
    if (distance > gapTolerance) {
      continue
    }
    if (!nearest || distance < nearest.distance) {
      nearest = { status: rect.status, distance }
    }
  }

  return nearest?.status ?? null
}

export function resolveWorkspaceCardDropIndexFromRects(
  rects: readonly WorkspaceKanbanCardDropRect[],
  y: number
): number {
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]!
    if (y < (rect.top + rect.bottom) / 2) {
      return index
    }
  }
  return rects.length
}

function hasWorkspaceKanbanCardDropTarget(target: WorkspaceKanbanCardDropTarget): boolean {
  return target.isPinDrop || target.status !== null
}

export function resolveWorkspaceKanbanCardDropCommitTarget(args: {
  currentTarget: WorkspaceKanbanCardDropTarget
  latestTrackedTarget: WorkspaceKanbanCardTrackedDropTarget | null
  x: number
  y: number
}): WorkspaceKanbanCardDropTarget {
  if (hasWorkspaceKanbanCardDropTarget(args.currentTarget)) {
    return args.currentTarget
  }
  const latest = args.latestTrackedTarget
  if (!latest || !hasWorkspaceKanbanCardDropTarget(latest.target)) {
    return args.currentTarget
  }
  const distance = Math.hypot(args.x - latest.x, args.y - latest.y)
  return distance <= COMMIT_TARGET_FALLBACK_TOLERANCE_PX ? latest.target : args.currentTarget
}

function getStatusDropTargetRects(board: HTMLElement): WorkspaceKanbanStatusDropRect[] {
  return Array.from(board.querySelectorAll<HTMLElement>(STATUS_DROP_TARGET)).flatMap((element) => {
    const status = element.dataset.workspaceStatus
    if (!status) {
      return []
    }
    const rect = element.getBoundingClientRect()
    return [
      {
        status,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      }
    ]
  })
}

export function getDropTarget(
  board: HTMLElement,
  x: number,
  y: number
): { status: WorkspaceStatus | null; isPinDrop: boolean } {
  const target = document.elementFromPoint(x, y)
  if (!(target instanceof Element) || !board.contains(target)) {
    return { status: null, isPinDrop: false }
  }

  const pinTarget = target.closest<HTMLElement>(PIN_DROP_TARGET)
  if (pinTarget && board.contains(pinTarget)) {
    return { status: null, isPinDrop: true }
  }

  const statusTarget = target.closest<HTMLElement>(STATUS_DROP_TARGET)
  const directStatus =
    statusTarget && board.contains(statusTarget)
      ? (statusTarget.dataset.workspaceStatus ?? null)
      : null
  return {
    // Why: dropping in the visual gap between lanes should still land in the
    // nearest lane. Without this fallback, otherwise-valid drags appeared flaky.
    status:
      directStatus ??
      resolveWorkspaceStatusDropTargetFromRects(getStatusDropTargetRects(board), x, y),
    isPinDrop: false
  }
}

function getLaneForStatus(board: HTMLElement, status: WorkspaceStatus): HTMLElement | null {
  return (
    Array.from(board.querySelectorAll<HTMLElement>(STATUS_DROP_TARGET)).find(
      (element) => element.dataset.workspaceStatus === status
    ) ?? null
  )
}

export function getCardDropTarget(
  board: HTMLElement,
  x: number,
  y: number
): WorkspaceKanbanCardDropTarget {
  const target = getDropTarget(board, x, y)
  if (!target.status) {
    return { ...target, dropIndex: 0 }
  }

  const lane = getLaneForStatus(board, target.status)
  if (!lane) {
    return { ...target, dropIndex: 0 }
  }

  const laneContent = lane.querySelector<HTMLElement>('[data-workspace-board-lane-scroll]')
  const laneClientRect = (laneContent ?? lane).getBoundingClientRect()
  const cardRects = Array.from(lane.querySelectorAll<HTMLElement>(CARD_SELECTOR))
    .filter((card) => card.offsetParent !== null)
    .map((card) => {
      const rect = card.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    })
  const dropIndex = resolveWorkspaceCardDropIndexFromRects(cardRects, y)
  return {
    ...target,
    dropIndex,
    laneRect: {
      left: laneClientRect.left,
      top: laneClientRect.top,
      width: laneClientRect.width
    },
    cardRects
  }
}

function getOrCreateDropIndicator(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${POINTER_DROP_INDICATOR_ATTR}]`)
  if (existing) {
    return existing
  }
  const indicator = document.createElement('div')
  indicator.setAttribute(POINTER_DROP_INDICATOR_ATTR, 'true')
  indicator.setAttribute('aria-hidden', 'true')
  indicator.style.setProperty('position', 'fixed')
  indicator.style.setProperty('left', '0')
  indicator.style.setProperty('top', '0')
  indicator.style.setProperty('pointer-events', 'none')
  document.body.appendChild(indicator)
  return indicator
}

export function removeCardDropIndicator(): void {
  document.querySelector<HTMLElement>(`[${POINTER_DROP_INDICATOR_ATTR}]`)?.remove()
}

export function updateCardDropIndicator(
  board: HTMLElement,
  target: WorkspaceKanbanCardDropTarget
): void {
  if (!target.status || target.isPinDrop) {
    removeCardDropIndicator()
    return
  }

  const lane = getLaneForStatus(board, target.status)
  if (!lane) {
    removeCardDropIndicator()
    return
  }

  const fallbackLaneContent = target.laneRect
    ? null
    : lane.querySelector<HTMLElement>('[data-workspace-board-lane-scroll]')
  const fallbackLaneRect = target.laneRect
    ? null
    : (fallbackLaneContent ?? lane).getBoundingClientRect()
  const laneRect =
    target.laneRect ??
    (fallbackLaneRect
      ? {
          left: fallbackLaneRect.left,
          top: fallbackLaneRect.top,
          width: fallbackLaneRect.width
        }
      : { left: 0, top: 0, width: 0 })
  const cardRects =
    target.cardRects ??
    Array.from(lane.querySelectorAll<HTMLElement>(CARD_SELECTOR))
      .filter((card) => card.offsetParent !== null)
      .map((card) => {
        const rect = card.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom }
      })
  const boundedDropIndex = Math.max(0, Math.min(cardRects.length, target.dropIndex))
  const y =
    cardRects.length === 0
      ? laneRect.top + 14
      : boundedDropIndex === 0
        ? cardRects[0]!.top - 5
        : boundedDropIndex >= cardRects.length
          ? cardRects.at(-1)!.bottom + 5
          : (cardRects[boundedDropIndex - 1]!.bottom + cardRects[boundedDropIndex]!.top) / 2
  const horizontalInset = 8
  const indicator = getOrCreateDropIndicator()
  indicator.dataset.workspaceStatus = target.status
  indicator.style.setProperty('width', `${Math.max(32, laneRect.width - horizontalInset * 2)}px`)
  indicator.style.setProperty(
    'transform',
    `translate3d(${laneRect.left + horizontalInset}px, ${y}px, 0)`
  )
  indicator.style.setProperty('opacity', '1')
}
