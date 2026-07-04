import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager'
import type { AppState } from '@/store'
import type { TerminalTab } from '../../../../shared/types'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'

const TAB_GROUP_STRIP_SELECTOR = '[data-tab-group-strip-id][data-worktree-id]'

export type TerminalPaneTabDetachStore = Pick<
  AppState,
  | 'createTab'
  | 'groupsByWorktree'
  | 'reorderUnifiedTabs'
  | 'setActiveTab'
  | 'setActiveTabType'
  | 'setTabLayout'
  | 'syncPaneDetachPtyOwnership'
  | 'terminalLayoutsByTabId'
>

type TerminalPaneTabDetachManager = {
  getPanes: () => readonly { id: number }[]
  getLeafId: (paneId: number) => string | null
  detachPaneForExternalMove: (paneId: number) => boolean
}

export type TerminalTabStripDropTarget = PaneExternalDropTarget & {
  groupId: string
  insertionIndex?: number
  worktreeId: string
}

export type DetachedTerminalPaneTab = {
  tab: TerminalTab
  leafId: string
  ptyId: string | null
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
  groupsByWorktree: TerminalPaneTabDetachStore['groupsByWorktree']
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

function withDetachedPtyFallback(args: {
  leafId: string
  ptyId: string | null
  detachedLayout: NonNullable<ReturnType<typeof detachTerminalLayoutLeaf>>['detachedLayout']
}): NonNullable<ReturnType<typeof detachTerminalLayoutLeaf>>['detachedLayout'] {
  if (!args.ptyId || args.detachedLayout.ptyIdsByLeafId?.[args.leafId]) {
    return args.detachedLayout
  }
  return {
    ...args.detachedLayout,
    ptyIdsByLeafId: {
      ...args.detachedLayout.ptyIdsByLeafId,
      [args.leafId]: args.ptyId
    }
  }
}

export function isTerminalTabStripDropTarget(
  target: PaneExternalDropTarget
): target is TerminalTabStripDropTarget {
  const candidate = target as Partial<TerminalTabStripDropTarget>
  return typeof candidate.groupId === 'string' && typeof candidate.worktreeId === 'string'
}

function moveCreatedTabToIndex(args: {
  groupId: string
  store: TerminalPaneTabDetachStore
  tabId: string
  targetIndex: number | undefined
  worktreeId: string
}): void {
  if (args.targetIndex === undefined) {
    return
  }
  const group = args.store.groupsByWorktree[args.worktreeId]?.find(
    (candidate) => candidate.id === args.groupId
  )
  if (!group) {
    return
  }
  const orderWithoutCreatedTab = (group.tabOrder ?? []).filter((id) => id !== args.tabId)
  const insertionIndex = clampIndex(args.targetIndex, orderWithoutCreatedTab.length)
  const nextOrder = [...orderWithoutCreatedTab]
  nextOrder.splice(insertionIndex, 0, args.tabId)
  args.store.reorderUnifiedTabs(args.groupId, nextOrder, { recordInteraction: false })
}

export function detachTerminalPaneToTab(args: {
  fallbackPtyId?: string | null
  getStore: () => TerminalPaneTabDetachStore
  manager: TerminalPaneTabDetachManager | null
  persistLayoutSnapshot: () => void
  sourcePaneId: number
  sourceTabId: string
  targetGroupId: string
  targetIndex?: number
  worktreeId: string
}): DetachedTerminalPaneTab | null {
  const initialStore = args.getStore()
  const targetGroupExists =
    initialStore.groupsByWorktree[args.worktreeId]?.some(
      (group) => group.id === args.targetGroupId
    ) ?? false
  if (!args.manager || !targetGroupExists || args.manager.getPanes().length <= 1) {
    return null
  }

  const sourceLeafId = args.manager.getLeafId(args.sourcePaneId)
  if (!sourceLeafId) {
    return null
  }

  args.persistLayoutSnapshot()
  const store = args.getStore()
  const detached = detachTerminalLayoutLeaf(
    store.terminalLayoutsByTabId[args.sourceTabId],
    sourceLeafId
  )
  if (!detached) {
    return null
  }

  const ptyId = detached.ptyId ?? args.fallbackPtyId ?? null
  const detachedLayout = withDetachedPtyFallback({
    leafId: sourceLeafId,
    ptyId,
    detachedLayout: detached.detachedLayout
  })

  // Why: remove the renderer pane only after the layout/PTY handoff has been
  // computed; the close callback detaches listeners but must not kill the PTY.
  if (!args.manager.detachPaneForExternalMove(args.sourcePaneId)) {
    return null
  }

  const latestStore = args.getStore()
  const tab = latestStore.createTab(args.worktreeId, args.targetGroupId, undefined, {
    activate: true,
    initialPtyId: ptyId ?? undefined,
    recordInteraction: true
  })
  const afterCreateStore = args.getStore()
  moveCreatedTabToIndex({
    groupId: args.targetGroupId,
    store: afterCreateStore,
    tabId: tab.id,
    targetIndex: args.targetIndex,
    worktreeId: args.worktreeId
  })
  afterCreateStore.setTabLayout(args.sourceTabId, detached.sourceLayout)
  afterCreateStore.setTabLayout(tab.id, detachedLayout)
  afterCreateStore.syncPaneDetachPtyOwnership({
    detachedPtyId: ptyId,
    sourceLayout: detached.sourceLayout,
    sourceTabId: args.sourceTabId,
    targetTabId: tab.id
  })
  afterCreateStore.setActiveTab(tab.id)
  afterCreateStore.setActiveTabType('terminal')

  return { tab, leafId: sourceLeafId, ptyId }
}
