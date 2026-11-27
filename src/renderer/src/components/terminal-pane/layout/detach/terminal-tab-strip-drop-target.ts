import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager-types'
import type { AppState } from '@/store/types'

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
  stripRect: DOMRect
): DOMRect {
  const markerWidth = 2
  const clampedIndex = clampIndex(insertionIndex, tabRects.length)
  const rawLeft =
    clampedIndex < tabRects.length
      ? (tabRects[clampedIndex]?.left ?? stripRect.left)
      : (tabRects.at(-1)?.right ?? stripRect.left) - markerWidth
  const left = Math.min(Math.max(rawLeft, stripRect.left), stripRect.right - markerWidth)
  return rectFromBox({ left, top: stripRect.top, width: markerWidth, height: stripRect.height })
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
  const tabRects = tabs.map((tab) => tab.getBoundingClientRect())

  for (let index = 0; index < tabRects.length; index += 1) {
    const tabRect = tabRects[index]
    if (!tabRect) {
      continue
    }
    if (args.clientX < tabRect.left) {
      const insertionIndex = clampIndex(index, args.groupTabOrderLength)
      return {
        index: insertionIndex,
        rect: getInsertionMarkerRect(tabRects, insertionIndex, args.stripRect)
      }
    }
    if (pointWithinRect(args.clientX, args.clientY, tabRect)) {
      const insertionIndex = clampIndex(
        index + (args.clientX < tabRect.left + tabRect.width / 2 ? 0 : 1),
        args.groupTabOrderLength
      )
      return {
        index: insertionIndex,
        rect: getInsertionMarkerRect(tabRects, insertionIndex, args.stripRect)
      }
    }
  }

  const insertionIndex = args.groupTabOrderLength
  return {
    index: insertionIndex,
    rect: getInsertionMarkerRect(tabRects, insertionIndex, args.stripRect)
  }
}

function resolveWrappedTabInsertion(
  strip: HTMLElement,
  box: DOMRect,
  tabOrder: readonly string[],
  clientX: number,
  clientY: number
): { index: number; rect: DOMRect } | null {
  let target: { index: number; rect: DOMRect; after: boolean } | null = null
  for (const tab of getTabElements(strip)) {
    const rect = tab.getBoundingClientRect()
    if (clientY < rect.top || clientY >= rect.bottom) {
      continue
    }
    const index = tabOrder.indexOf(tab.dataset.unifiedTabId ?? '')
    if (index === -1) {
      continue
    }
    const after =
      clientX >= rect.left + rect.width / 2 || tab.closest('[data-pinned-home-slot]') !== null
    target = { index, rect, after }
    if (!after || clientX <= rect.right) {
      break
    }
  }
  if (!target) {
    return null
  }

  const { index, rect, after } = target
  const width = 2
  const edge = after ? rect.right - width : rect.left
  const top = Math.max(box.top, rect.top)
  return {
    index: index + Number(after),
    rect: rectFromBox({
      left: Math.min(Math.max(box.left, edge), box.right - width),
      top,
      width,
      height: Math.min(box.bottom, rect.bottom) - top
    })
  }
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
    const tabOrder = group?.tabOrder ?? []
    const insertion =
      strip.dataset.tabGroupStripLayout === 'wrapped'
        ? resolveWrappedTabInsertion(strip, rect, tabOrder, args.clientX, args.clientY)
        : resolveTabStripInsertion({
            clientX: args.clientX,
            clientY: args.clientY,
            groupTabOrderLength: tabOrder.length,
            strip,
            stripRect: rect
          })
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
