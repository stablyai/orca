import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { getLineageRenderInfo } from './worktree-lineage-projection'
import {
  getWorktreeSidebarStaticRect,
  getWorktreeSidebarVirtualRowStart,
  type WorktreeSidebarStaticGeometry,
  type WorktreeSidebarStaticRect
} from './worktree-sidebar-static-geometry'

const WORKTREE_CARD_SURFACE_SELECTOR = '[data-worktree-card-surface]'
const WORKTREE_BUSY_CARD_SURFACE_SELECTOR = `${WORKTREE_CARD_SURFACE_SELECTOR}[aria-busy='true']`
const WORKTREE_LINEAGE_CHILDREN_SELECTOR =
  '[data-worktree-lineage-children],[data-worktree-legacy-lineage-children]'
const WORKTREE_LINEAGE_DROP_ROW_SELECTOR = '[data-worktree-lineage-drop-id]'
const WORKTREE_STICKY_HEADER_SELECTOR = '[data-worktree-sticky-header-active]'
const WORKTREE_VIRTUAL_ROW_SELECTOR = '[data-worktree-virtual-row]'
const WORKTREE_CARD_PARENT_CONTENT_SELECTOR = '[data-worktree-card-parent-content]'

const LINEAGE_REORDER_GUTTER_PX = 8
const LINEAGE_REORDER_GUTTER_RATIO = 0.25

type VerticalRect = Pick<DOMRect, 'top' | 'bottom'>
type PointerPosition = { pointerX: number; pointerY: number }

type StaticVirtualRowHit = {
  foundVirtualRows: boolean
  row: HTMLElement | null
}

export function isWorktreeLineageDropZoneHit(args: {
  pointerY: number
  rect: VerticalRect
}): boolean {
  const height = Math.max(0, args.rect.bottom - args.rect.top)
  if (height <= 0) {
    return false
  }

  const gutter = Math.min(LINEAGE_REORDER_GUTTER_PX, height * LINEAGE_REORDER_GUTTER_RATIO)
  const zoneTop = args.rect.top + gutter
  const zoneBottom = args.rect.bottom - gutter
  return args.pointerY >= zoneTop && args.pointerY <= zoneBottom
}

export function getWorktreeLineageDropTargetId(args: {
  container: HTMLElement
  target: Element
  pointerX: number
  pointerY: number
}): string | null {
  if (
    !args.container.contains(args.target) ||
    args.target.closest<HTMLElement>(WORKTREE_STICKY_HEADER_SELECTOR)
  ) {
    return null
  }
  const containerRect = args.container.getBoundingClientRect()
  if (!isPointInRect(args, containerRect)) {
    return null
  }

  const geometry: WorktreeSidebarStaticGeometry = {
    containerTop: containerRect.top,
    scrollTop: args.container.scrollTop
  }
  const virtualRowHit = getStaticVirtualRowAtPoint(args, geometry)
  if (virtualRowHit.foundVirtualRows) {
    const cardSurface = virtualRowHit.row?.querySelector<HTMLElement>(
      WORKTREE_CARD_SURFACE_SELECTOR
    )
    return cardSurface ? getLineageTargetFromSurface(args, cardSurface, geometry) : null
  }

  const cardSurface = args.target.closest<HTMLElement>(WORKTREE_CARD_SURFACE_SELECTOR)
  return cardSurface && args.container.contains(cardSurface)
    ? getLineageTargetFromSurface(args, cardSurface, geometry)
    : null
}

function getLineageTargetFromSurface(
  point: PointerPosition & { container: HTMLElement },
  cardSurface: HTMLElement,
  geometry: WorktreeSidebarStaticGeometry
): string | null {
  const rect = getWorktreeSidebarStaticRect(point.container, cardSurface, geometry)
  if (cardSurface.closest(WORKTREE_BUSY_CARD_SURFACE_SELECTOR) || !isPointInRect(point, rect)) {
    return null
  }

  const lineageChildren = getOwnedLineageChildren(cardSurface)
  if (
    lineageChildren &&
    isPointInRect(point, getWorktreeSidebarStaticRect(point.container, lineageChildren, geometry))
  ) {
    const childSurface = findChildSurfaceAtPoint(point, lineageChildren, point.container, geometry)
    return childSurface ? getLineageTargetFromSurface(point, childSurface, geometry) : null
  }

  if (!isWorktreeLineageDropZoneHit({ pointerY: point.pointerY, rect })) {
    return null
  }
  const rowTarget = cardSurface.closest<HTMLElement>(WORKTREE_LINEAGE_DROP_ROW_SELECTOR)
  return rowTarget && point.container.contains(rowTarget)
    ? rowTarget.getAttribute('data-worktree-lineage-drop-id')
    : null
}

function getStaticVirtualRowAtPoint(
  point: PointerPosition & { container: HTMLElement; target: Element },
  geometry: WorktreeSidebarStaticGeometry
): StaticVirtualRowHit {
  const targetRow = point.target.closest<HTMLElement>(WORKTREE_VIRTUAL_ROW_SELECTOR)
  if (
    targetRow &&
    point.container.contains(targetRow) &&
    isPointInRect(point, getWorktreeSidebarStaticRect(point.container, targetRow, geometry))
  ) {
    return { foundVirtualRows: true, row: targetRow }
  }

  const firstChild = point.container.firstElementChild
  const rowsHost =
    targetRow?.parentElement ??
    (firstChild?.matches(WORKTREE_VIRTUAL_ROW_SELECTOR) ? point.container : firstChild)
  if (!(rowsHost instanceof HTMLElement)) {
    return { foundVirtualRows: false, row: null }
  }

  const pointerContentY = point.pointerY - geometry.containerTop + geometry.scrollTop
  let foundVirtualRows = false
  let candidate: HTMLElement | null = null
  for (const child of rowsHost.children) {
    if (!(child instanceof HTMLElement) || !child.matches(WORKTREE_VIRTUAL_ROW_SELECTOR)) {
      continue
    }
    foundVirtualRows = true
    const start = getWorktreeSidebarVirtualRowStart(child)
    if (start === null) {
      continue
    }
    if (start > pointerContentY) {
      break
    }
    candidate = child
  }
  return { foundVirtualRows, row: candidate }
}

function getOwnedLineageChildren(cardSurface: HTMLElement): HTMLElement | null {
  const directCandidate = cardSurface.lastElementChild
  if (
    directCandidate instanceof HTMLElement &&
    directCandidate.matches(WORKTREE_LINEAGE_CHILDREN_SELECTOR)
  ) {
    return directCandidate
  }

  // Why: legacy lineage is last in the content column; avoid walking long agent subtrees.
  const parentContent = cardSurface.querySelector<HTMLElement>(
    WORKTREE_CARD_PARENT_CONTENT_SELECTOR
  )
  const contentColumn = parentContent?.lastElementChild
  const legacyCandidate = contentColumn?.lastElementChild
  return legacyCandidate instanceof HTMLElement &&
    legacyCandidate.matches(WORKTREE_LINEAGE_CHILDREN_SELECTOR)
    ? legacyCandidate
    : null
}

function findChildSurfaceAtPoint(
  point: PointerPosition,
  lineageChildren: HTMLElement,
  container: HTMLElement,
  geometry: WorktreeSidebarStaticGeometry
): HTMLElement | null {
  const rows = lineageChildren.children
  let low = 0
  let high = rows.length - 1
  let candidate: HTMLElement | null = null
  let candidateRect: WorktreeSidebarStaticRect | null = null
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const childRow = rows.item(middle)
    const childSurface = childRow?.querySelector<HTMLElement>(WORKTREE_CARD_SURFACE_SELECTOR)
    if (!childSurface) {
      return null
    }
    const rect = getWorktreeSidebarStaticRect(container, childSurface, geometry)
    if (rect.top <= point.pointerY) {
      candidate = childSurface
      candidateRect = rect
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (!candidate || !candidateRect) {
    return null
  }
  return isPointInRect(point, candidateRect) ? candidate : null
}

function isPointInRect(
  point: PointerPosition,
  rect: Pick<WorktreeSidebarStaticRect, 'left' | 'right' | 'top' | 'bottom'>
): boolean {
  return (
    point.pointerX >= rect.left &&
    point.pointerX <= rect.right &&
    point.pointerY >= rect.top &&
    point.pointerY <= rect.bottom
  )
}

export function getTopLevelWorktreeLineageDragIds(args: {
  draggedIds: readonly string[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
  worktreeMap: ReadonlyMap<string, Worktree>
  cyclicLineageIds: ReadonlySet<string>
}): string[] {
  const selectedIds = new Set(args.draggedIds)
  const included = new Set<string>()
  const roots: string[] = []
  for (const id of args.draggedIds) {
    if (included.has(id)) {
      continue
    }
    included.add(id)
    let current = args.worktreeMap.get(id)
    let selectedAncestor = false
    while (current) {
      const lineage = getLineageRenderInfo(
        current,
        args.lineageById,
        args.worktreeMap,
        args.cyclicLineageIds
      )
      if (lineage.state !== 'valid') {
        break
      }
      if (selectedIds.has(lineage.parent.id)) {
        selectedAncestor = true
        break
      }
      current = lineage.parent
    }
    if (!selectedAncestor) {
      roots.push(id)
    }
  }
  return roots
}

export function getWorktreeLineageDragRootId(args: {
  worktreeId: string
  lineageRootIds: readonly string[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
  worktreeMap: ReadonlyMap<string, Worktree>
  cyclicLineageIds: ReadonlySet<string>
}): string {
  const rootIds = new Set(args.lineageRootIds)
  let current = args.worktreeMap.get(args.worktreeId)
  while (current) {
    if (rootIds.has(current.id)) {
      return current.id
    }
    const lineage = getLineageRenderInfo(
      current,
      args.lineageById,
      args.worktreeMap,
      args.cyclicLineageIds
    )
    if (lineage.state !== 'valid') {
      break
    }
    current = lineage.parent
  }
  return args.worktreeId
}

export function getReorderedWorktreeIdsToUnnest(args: {
  draggedIds: readonly string[]
  sourceGroupIds: readonly string[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
  worktreeMap: ReadonlyMap<string, Worktree>
  cyclicLineageIds: ReadonlySet<string>
}): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const sourceGroupIdSet = new Set(args.sourceGroupIds)
  for (const id of args.draggedIds) {
    const worktree = args.worktreeMap.get(id)
    if (
      seen.has(id) ||
      !sourceGroupIdSet.has(id) ||
      !worktree ||
      getLineageRenderInfo(worktree, args.lineageById, args.worktreeMap, args.cyclicLineageIds)
        .state !== 'valid'
    ) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}
