import type React from 'react'
import type { AreaSelectionCardRect } from './workspace-kanban-area-selection-card-rects'

export type AreaSelectionDragState = {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
  baseSelectedIds: Set<string>
  baseAnchorId: string | null
  boardRect: DOMRect
  cardRects: readonly AreaSelectionCardRect[]
  scrollStartContentYByElement: ReadonlyMap<HTMLElement, number>
  previewIds: Set<string>
  finalAreaIds: string[]
  started: boolean
  frameId: number | null
  scrollFrameId: number | null
}

type UpdateSelectionForArea = (
  areaIds: readonly string[],
  additive: boolean,
  baseSelectedIds?: ReadonlySet<string>,
  baseAnchorId?: string | null
) => void

export type UseWorkspaceKanbanAreaSelectionParams = {
  open: boolean
  boardRef: React.RefObject<HTMLDivElement | null>
  overlayRef: React.RefObject<HTMLDivElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectionAnchorId: string | null
  updateSelectionForArea: UpdateSelectionForArea
}

export const AREA_SELECTION_DRAG_THRESHOLD = 4

export function shouldCommitWorkspaceKanbanAreaSelection({
  additive,
  started
}: {
  additive: boolean
  started: boolean
}): boolean {
  // Why: a plain click on empty board space is the user's "click off" gesture;
  // modifier-clicking empty space should not accidentally drop a selected batch.
  return started || !additive
}
