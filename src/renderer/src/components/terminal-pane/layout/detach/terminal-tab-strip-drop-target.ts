import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager-types'
import type { AppState } from '@/store/types'
import { TAB_STRIP_ORIENTATION } from '../../../tab-bar/tab-strip-orientation'

const TAB_GROUP_STRIP_SELECTOR = '[data-tab-group-strip-id][data-worktree-id]'

export type TerminalTabStripDropTarget = PaneExternalDropTarget & {
  groupId: string
  insertionIndex?: number
  worktreeId: string
}

function pointWithinRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  )
}

function rectFromBox(args: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    left: args.left,
    top: args.top,
    right: args.left + args.width,
    bottom: args.top + args.height,
    width: args.width,
    height: args.height
  } as DOMRect
}

function clampIndex(index: number, max: number): number {
  return Math.min(Math.max(index, 0), max)
}

function getTabElements(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]')).filter(
    (element) => typeof element.dataset.tabId === 'string' && element.dataset.tabId.length > 0
  )
}

function getInsertionMarkerRect(
  tabRects: DOMRect[],
  insertionIndex: number,
  stripRect: DOMRect,
  vertical: boolean
): DOMRect {
  const markerSize = 2
  const clampedIndex = clampIndex(insertionIndex, tabRects.length)
  const nextTab = clampedIndex < tabRects.length ? tabRects[clampedIndex] : undefined
  const lastTab = tabRects.at(-1)
  if (vertical) {
    const rawTop = nextTab?.top ?? (lastTab?.bottom ?? stripRect.top) - markerSize
    const top = Math.min(Math.max(rawTop, stripRect.top), stripRect.bottom - markerSize)
    return rectFromBox({ left: stripRect.left, top, width: stripRect.width, height: markerSize })
  }
  const rawLeft =
    clampedIndex < tabRects.length
      ? (nextTab?.left ?? stripRect.left)
      : (lastTab?.right ?? stripRect.left) - markerSize
  const left = Math.min(Math.max(rawLeft, stripRect.left), stripRect.right - markerSize)
  return rectFromBox({ left, top: stripRect.top, width: markerSize, height: stripRect.height })
}

function resolveTabStripInsertion(args: {
  clientX: number
  clientY: number
  groupTabOrderLength: number
  strip: HTMLElement
  stripRect: DOMRect
}): { index: number; rect: DOMRect } | null {
  const tabs = getTabElements(args.strip)
  if (tabs.length === 0) {
    return null
  }
  const vertical = args.strip.dataset.tabStripOrientation === TAB_STRIP_ORIENTATION.vertical
  const pointer = vertical ? args.clientY : args.clientX
  const tabRects = tabs.map((tab) => tab.getBoundingClientRect())
  const insertAt = (index: number): { index: number; rect: DOMRect } => {
    const insertionIndex = clampIndex(index, args.groupTabOrderLength)
    return {
      index: insertionIndex,
      rect: getInsertionMarkerRect(tabRects, insertionIndex, args.stripRect, vertical)
    }
  }

  for (let index = 0; index < tabRects.length; index += 1) {
    const tabRect = tabRects[index]
    if (!tabRect) {
      continue
    }
    const start = vertical ? tabRect.top : tabRect.left
    const size = vertical ? tabRect.height : tabRect.width
    if (pointer < start) {
      return insertAt(index)
    }
    if (pointWithinRect(args.clientX, args.clientY, tabRect)) {
      return insertAt(index + (pointer < start + size / 2 ? 0 : 1))
    }
  }

  return insertAt(args.groupTabOrderLength)
}

function getElementsFromPoint(clientX: number, clientY: number): Element[] {
  if (typeof document === 'undefined') {
    return []
  }
  const elements = document.elementsFromPoint?.(clientX, clientY)
  if (elements && elements.length > 0) {
    return elements
  }
  const element = document.elementFromPoint?.(clientX, clientY)
  return element ? [element] : []
}

export function resolveTerminalTabStripDropTarget(args: {
  clientX: number
  clientY: number
  groupsByWorktree: AppState['groupsByWorktree']
  worktreeId: string
}): TerminalTabStripDropTarget | null {
  const groups = args.groupsByWorktree[args.worktreeId] ?? []
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const validGroupIds = new Set(groups.map((group) => group.id))
  if (validGroupIds.size === 0) {
    return null
  }

  for (const element of getElementsFromPoint(args.clientX, args.clientY)) {
    const strip = element.closest<HTMLElement>(TAB_GROUP_STRIP_SELECTOR)
    const groupId = strip?.dataset.tabGroupStripId
    const worktreeId = strip?.dataset.worktreeId
    if (!strip || !groupId || worktreeId !== args.worktreeId || !validGroupIds.has(groupId)) {
      continue
    }
    const rect = strip.getBoundingClientRect()
    if (!pointWithinRect(args.clientX, args.clientY, rect)) {
      continue
    }
    const group = groupById.get(groupId)
    const insertion = group
      ? resolveTabStripInsertion({
          clientX: args.clientX,
          clientY: args.clientY,
          groupTabOrderLength: group.tabOrder?.length ?? 0,
          strip,
          stripRect: rect
        })
      : null
    return insertion
      ? {
          id: groupId,
          groupId,
          insertionIndex: insertion.index,
          overlayKind: 'insertion',
          rect: insertion.rect,
          worktreeId
        }
      : { id: groupId, groupId, worktreeId, rect }
  }

  return null
}

export function isTerminalTabStripDropTarget(
  target: PaneExternalDropTarget
): target is TerminalTabStripDropTarget {
  const candidate = target as Partial<TerminalTabStripDropTarget>
  return typeof candidate.groupId === 'string' && typeof candidate.worktreeId === 'string'
}
