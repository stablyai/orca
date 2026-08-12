import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import { serializeWorkspaceLaneFullIds } from './workspace-kanban-filtered-drop-index'
import {
  buildWorkspaceKanbanSidebarDropUpdates,
  clearWorkspaceKanbanSidebarDropTargetVisual,
  getWorkspaceKanbanSidebarDropGroups,
  getWorkspaceKanbanSidebarDropTarget,
  isWorkspaceKanbanSidebarDropPointInBoard,
  registerWorkspaceKanbanSidebarDropGroups,
  resolveWorkspaceKanbanSidebarFullLaneDropIndex,
  updateWorkspaceKanbanSidebarDropTargetVisual
} from './workspace-kanban-sidebar-drop'
import { registerWorkspaceKanbanVirtualLaneLayout } from './workspace-kanban-virtual-lane-layout'

const workspaceStatuses: WorkspaceStatusDefinition[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'doing', label: 'Doing' }
]

class FakeNode {
  parentElement: FakeElement | null = null
}

class FakeElement extends FakeNode {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly style = {
    setProperty: (name: string, value: string) => {
      this.styleValues.set(name, value)
    }
  }
  offsetParent: FakeElement | null = null
  scrollTop = 0
  private readonly attributes = new Map<string, string>()
  private rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'> = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0
  }
  private readonly styleValues = new Map<string, string>()

  append(...elements: FakeElement[]): void {
    for (const element of elements) {
      element.parentElement = this
      this.children.push(element)
    }
  }

  appendChild(element: FakeElement): FakeElement {
    this.append(element)
    return element
  }

  remove(): void {
    if (!this.parentElement) {
      return
    }
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    if (index !== -1) {
      siblings.splice(index, 1)
    }
    this.parentElement = null
  }

  contains(target: FakeNode): boolean {
    return target === this || this.children.some((child) => child.contains(target))
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) {
      return this
    }
    return this.parentElement?.closest(selector) ?? null
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = []
    for (const child of this.children) {
      if (child.matches(selector)) {
        results.push(child)
      }
      results.push(...child.querySelectorAll(selector))
    }
    return results
  }

  getBoundingClientRect(): DOMRect {
    return this.rect as DOMRect
  }

  setRect(rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>): void {
    this.rect = rect
  }

  matches(selector: string): boolean {
    return selector
      .split(',')
      .map((part) => part.trim())
      .some((part) => {
        if (!part.startsWith('[') || !part.endsWith(']')) {
          return false
        }
        const attribute = part.slice(1, -1)
        return this.attributes.has(attribute)
      })
  }
}

class FakeDocument {
  readonly body = new FakeElement()
  private pointTarget: FakeElement = this.body

  createElement(): FakeElement {
    return new FakeElement()
  }

  querySelector(selector: string): FakeElement | null {
    if (this.body.matches(selector)) {
      return this.body
    }
    return this.body.querySelector(selector)
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results = this.body.matches(selector) ? [this.body] : []
    results.push(...this.body.querySelectorAll(selector))
    return results
  }

  elementFromPoint(): FakeElement {
    return this.pointTarget
  }

  setElementFromPoint(element: FakeElement): void {
    this.pointTarget = element
  }
}

let fakeDocument: FakeDocument
let unregisterSidebarDropGroups: (() => void) | null = null

function setRect(
  element: HTMLElement,
  rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>
): void {
  ;(element as unknown as FakeElement).setRect(rect)
}

function setVisible(element: HTMLElement): void {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body
  })
}

function setElementFromPoint(element: Element): void {
  fakeDocument.setElementFromPoint(element as unknown as FakeElement)
}

function appendBoard(): { board: HTMLElement; lane: HTMLElement; firstCard: HTMLElement } {
  const board = document.createElement('div')
  board.setAttribute('data-workspace-board-selection-surface', '')
  setRect(board, { left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240 })

  const lane = document.createElement('section')
  lane.setAttribute('data-workspace-status-drop-target', '')
  lane.dataset.workspaceStatus = 'doing'
  setRect(lane, { left: 0, top: 0, right: 200, bottom: 220, width: 200, height: 220 })

  const firstCard = document.createElement('div')
  firstCard.setAttribute('data-workspace-board-card-id', 'doing-a')
  firstCard.dataset.workspaceBoardCardId = 'doing-a'
  setRect(firstCard, { left: 8, top: 8, right: 192, bottom: 48, width: 184, height: 40 })
  setVisible(firstCard)

  const secondCard = document.createElement('div')
  secondCard.setAttribute('data-workspace-board-card-id', 'doing-b')
  secondCard.dataset.workspaceBoardCardId = 'doing-b'
  setRect(secondCard, { left: 8, top: 56, right: 192, bottom: 96, width: 184, height: 40 })
  setVisible(secondCard)

  lane.append(firstCard, secondCard)
  board.append(lane)
  document.body.append(board)
  return { board, lane, firstCard }
}

const VIRTUAL_CARD_PITCH = 44
const VIRTUAL_CARD_HEIGHT = 36
// Scrolled past the head of the lane, so the mounted window starts mid-list.
const VIRTUAL_SPACER_TOP = -350

// A virtualized lane: only `windowRange` of the view is mounted, and the layout
// registration carries the whole view — exactly what the virtualizer publishes.
function appendVirtualBoard(args: {
  fullLaneIds: readonly string[]
  viewIds: readonly string[]
  windowRange: readonly [number, number]
  publishFullIds: boolean
}): { lane: HTMLElement; unregister: () => void } {
  const board = document.createElement('div')
  board.setAttribute('data-workspace-board-selection-surface', '')
  setRect(board, { left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240 })

  const lane = document.createElement('section')
  lane.setAttribute('data-workspace-status-drop-target', '')
  lane.dataset.workspaceStatus = 'doing'
  setRect(lane, { left: 0, top: 0, right: 200, bottom: 220, width: 200, height: 220 })
  if (args.publishFullIds) {
    lane.dataset.workspaceLaneFullIds = serializeWorkspaceLaneFullIds([...args.fullLaneIds]) ?? ''
  }

  const laneScroll = document.createElement('div')
  laneScroll.setAttribute('data-workspace-board-lane-scroll', '')
  setRect(laneScroll, { left: 0, top: 0, right: 200, bottom: 220, width: 200, height: 220 })

  const totalSize = args.viewIds.length * VIRTUAL_CARD_PITCH
  const spacer = document.createElement('div')
  setRect(spacer, {
    left: 8,
    top: VIRTUAL_SPACER_TOP,
    right: 192,
    bottom: VIRTUAL_SPACER_TOP + totalSize,
    width: 184,
    height: totalSize
  })

  for (let index = args.windowRange[0]; index <= args.windowRange[1]; index++) {
    const worktreeId = args.viewIds[index]!
    const card = document.createElement('div')
    card.setAttribute('data-workspace-board-card-id', worktreeId)
    card.dataset.workspaceBoardCardId = worktreeId
    card.dataset.workspaceBoardCardIndex = String(index)
    const top = VIRTUAL_SPACER_TOP + index * VIRTUAL_CARD_PITCH
    setRect(card, {
      left: 8,
      top,
      right: 192,
      bottom: top + VIRTUAL_CARD_HEIGHT,
      width: 184,
      height: VIRTUAL_CARD_HEIGHT
    })
    setVisible(card)
    spacer.append(card)
  }

  laneScroll.append(spacer)
  lane.append(laneScroll)
  board.append(lane)
  document.body.append(board)
  setElementFromPoint(lane)

  const unregister = registerWorkspaceKanbanVirtualLaneLayout({
    scrollElement: laneScroll,
    spacerElement: spacer,
    getItemIds: () => args.viewIds,
    getMeasurements: () =>
      args.viewIds.map((_, index) => ({
        index,
        start: index * VIRTUAL_CARD_PITCH,
        end: index * VIRTUAL_CARD_PITCH + VIRTUAL_CARD_HEIGHT
      }))
  })
  return { lane, unregister }
}

// 40-member lane under a search that matches every other card.
function searchedVirtualLaneIds(): { fullLaneIds: string[]; viewIds: string[] } {
  const fullLaneIds = Array.from({ length: 40 }, (_, index) => `doing-${index}`)
  return { fullLaneIds, viewIds: fullLaneIds.filter((_, index) => index % 2 === 0) }
}

function worktree(args: {
  id: string
  workspaceStatus: string
  sortOrder: number
  manualOrder?: number
}): Worktree {
  return {
    id: args.id,
    workspaceStatus: args.workspaceStatus,
    sortOrder: args.sortOrder,
    manualOrder: args.manualOrder
  } as Worktree
}

afterEach(() => {
  unregisterSidebarDropGroups?.()
  unregisterSidebarDropGroups = null
  clearWorkspaceKanbanSidebarDropTargetVisual()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  fakeDocument = new FakeDocument()
  vi.stubGlobal('Node', FakeNode)
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('document', fakeDocument)
})

describe('workspace kanban sidebar drop DOM bridge', () => {
  it('resolves the board lane and rendered card index under a sidebar pointer drag', () => {
    const { lane } = appendBoard()
    setElementFromPoint(lane)

    expect(getWorkspaceKanbanSidebarDropTarget(24, 60)).toMatchObject({
      status: 'doing',
      isPinDrop: false,
      dropIndex: 1
    })
    expect(getWorkspaceKanbanSidebarDropGroups()).toEqual([
      { key: 'doing', worktreeIds: ['doing-a', 'doing-b'] }
    ])
  })

  it('prefers complete registered groups and restores the DOM fallback on cleanup', () => {
    appendBoard()
    unregisterSidebarDropGroups = registerWorkspaceKanbanSidebarDropGroups([
      { key: 'doing', worktreeIds: ['doing-a', 'doing-b', 'doing-c', 'doing-d'] }
    ])

    expect(getWorkspaceKanbanSidebarDropGroups()).toEqual([
      { key: 'doing', worktreeIds: ['doing-a', 'doing-b', 'doing-c', 'doing-d'] }
    ])

    unregisterSidebarDropGroups()
    unregisterSidebarDropGroups = null
    expect(getWorkspaceKanbanSidebarDropGroups()).toEqual([
      { key: 'doing', worktreeIds: ['doing-a', 'doing-b'] }
    ])
  })

  it('uses the full virtual layout when the mounted card window is stale', () => {
    const { lane } = appendBoard()
    const laneScroll = document.createElement('div')
    laneScroll.setAttribute('data-workspace-board-lane-scroll', '')
    setRect(laneScroll, {
      left: 0,
      top: 0,
      right: 200,
      bottom: 220,
      width: 200,
      height: 220
    })
    const spacer = document.createElement('div')
    setRect(spacer, {
      left: 8,
      top: -4260,
      right: 192,
      bottom: 220,
      width: 184,
      height: 4480
    })
    laneScroll.append(spacer)
    lane.append(laneScroll)
    setElementFromPoint(lane)
    const unregister = registerWorkspaceKanbanVirtualLaneLayout({
      scrollElement: laneScroll,
      spacerElement: spacer,
      getItemIds: () => Array.from({ length: 102 }, (_, index) => `doing-${index}`),
      getMeasurements: () =>
        Array.from({ length: 102 }, (_, index) => ({
          index,
          start: index * 44,
          end: index * 44 + 36
        }))
    })

    expect(getWorkspaceKanbanSidebarDropTarget(24, 210)).toMatchObject({
      status: 'doing',
      dropIndex: 102,
      dropIndicatorY: 225,
      cardRects: [
        { top: 8, bottom: 48 },
        { top: 56, bottom: 96 }
      ]
    })
    unregister()
  })

  it('prefers the published full lane membership over the rendered card scan', () => {
    const { lane } = appendBoard()
    lane.dataset.workspaceLaneFullIds =
      serializeWorkspaceLaneFullIds(['doing-x', 'doing-a', 'doing-y', 'doing-b']) ?? ''
    setElementFromPoint(lane)

    expect(getWorkspaceKanbanSidebarDropGroups()).toEqual([
      { key: 'doing', worktreeIds: ['doing-x', 'doing-a', 'doing-y', 'doing-b'] }
    ])
  })

  it('keeps the tracked drop target in the rendered index space of the indicator', () => {
    const { lane } = appendBoard()
    lane.dataset.workspaceLaneFullIds =
      serializeWorkspaceLaneFullIds(['doing-x', 'doing-a', 'doing-y', 'doing-b']) ?? ''
    setElementFromPoint(lane)

    expect(getWorkspaceKanbanSidebarDropTarget(24, 60)).toMatchObject({
      status: 'doing',
      dropIndex: 1
    })
  })

  it('translates a rendered drop index onto the full lane at the commit boundary', () => {
    const { lane } = appendBoard()
    lane.dataset.workspaceLaneFullIds =
      serializeWorkspaceLaneFullIds(['doing-x', 'doing-a', 'doing-y', 'doing-b']) ?? ''
    setElementFromPoint(lane)

    // Rendered index 1 means "before doing-b", which is index 3 in the full lane.
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 1)).toBe(3)
    // Why: a tracked target can be committed after the pointer left the lane,
    // so the translation must not depend on the current pointer position.
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 2)).toBe(4)
  })

  it('lands a virtualized searched lane drop where the indicator pointed', () => {
    const { fullLaneIds, viewIds } = searchedVirtualLaneIds()
    const { unregister } = appendVirtualBoard({
      fullLaneIds,
      viewIds,
      windowRange: [8, 17],
      publishFullIds: true
    })

    const target = getWorkspaceKanbanSidebarDropTarget(24, 210)
    // The indicator sits between the mounted cards for view items 12 and 13,
    // whose full-lane neighbours are doing-24 and doing-26.
    expect(target).toMatchObject({ status: 'doing', dropIndex: 13, dropIndicatorY: 218 })
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', target.dropIndex)).toBe(26)

    unregister()
  })

  it('translates virtualized searched lane drops above and below the mounted window', () => {
    const { fullLaneIds, viewIds } = searchedVirtualLaneIds()
    const { unregister } = appendVirtualBoard({
      fullLaneIds,
      viewIds,
      windowRange: [8, 17],
      publishFullIds: true
    })

    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 0)).toBe(0)
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 3)).toBe(6)
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 19)).toBe(38)
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 20)).toBe(39)

    unregister()
  })

  it('passes a virtualized unfiltered lane drop index through untranslated', () => {
    const { fullLaneIds } = searchedVirtualLaneIds()
    const { unregister } = appendVirtualBoard({
      fullLaneIds,
      viewIds: fullLaneIds,
      windowRange: [8, 17],
      publishFullIds: false
    })

    expect(getWorkspaceKanbanSidebarDropGroups()).toEqual([
      { key: 'doing', worktreeIds: fullLaneIds }
    ])
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 13)).toBe(13)

    unregister()
  })

  it('still counts unlaid-out cards as lane members without a virtual layout', () => {
    const { lane } = appendBoard()
    const secondCard = lane.querySelectorAll<HTMLElement>('[data-workspace-board-card-id]')[1]!
    secondCard.remove()
    const hiddenCard = document.createElement('div')
    hiddenCard.setAttribute('data-workspace-board-card-id', 'doing-hidden')
    hiddenCard.dataset.workspaceBoardCardId = 'doing-hidden'
    lane.append(hiddenCard, secondCard)
    setElementFromPoint(lane)

    expect(getWorkspaceKanbanSidebarDropGroups()).toEqual([
      { key: 'doing', worktreeIds: ['doing-a', 'doing-hidden', 'doing-b'] }
    ])
    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('doing', 1)).toBe(2)
  })

  it('passes the drop index through for a lane it cannot find', () => {
    appendBoard()

    expect(resolveWorkspaceKanbanSidebarFullLaneDropIndex('todo', 2)).toBe(2)
  })

  it('marks and clears the external board hover target', () => {
    const { lane } = appendBoard()
    setElementFromPoint(lane)

    updateWorkspaceKanbanSidebarDropTargetVisual({
      x: 24,
      y: 60,
      shouldShowDropIndicator: () => true
    })

    expect(lane.getAttribute('data-workspace-board-external-drag-target')).toBe('true')
    expect(document.querySelector('[data-workspace-board-card-drop-indicator]')).not.toBeNull()

    clearWorkspaceKanbanSidebarDropTargetVisual()

    expect(lane.hasAttribute('data-workspace-board-external-drag-target')).toBe(false)
    expect(document.querySelector('[data-workspace-board-card-drop-indicator]')).toBeNull()
  })

  it('detects pointer entry across the whole board sheet', () => {
    const sheet = document.createElement('div')
    sheet.setAttribute('data-workspace-board-sheet', '')
    setRect(sheet, { left: 300, top: 36, right: 900, bottom: 700, width: 600, height: 664 })

    const { board } = appendBoard()
    board.remove()
    sheet.append(board)
    document.body.append(sheet)

    expect(isWorkspaceKanbanSidebarDropPointInBoard(320, 60)).toBe(true)
    expect(isWorkspaceKanbanSidebarDropPointInBoard(280, 60)).toBe(false)
    expect(isWorkspaceKanbanSidebarDropPointInBoard(320, 720)).toBe(false)
  })
})

describe('workspace kanban sidebar drop updates', () => {
  it('writes a status-only update for cross-lane drops outside Manual sort', () => {
    const worktreeById = new Map([
      ['todo-a', worktree({ id: 'todo-a', workspaceStatus: 'todo', sortOrder: 3000 })],
      ['doing-a', worktree({ id: 'doing-a', workspaceStatus: 'doing', sortOrder: 2000 })]
    ])

    const result = buildWorkspaceKanbanSidebarDropUpdates({
      worktreeIds: ['todo-a'],
      status: 'doing',
      dropIndex: 1,
      groups: [
        { key: 'todo', worktreeIds: ['todo-a'] },
        { key: 'doing', worktreeIds: ['doing-a'] }
      ],
      worktreeById,
      workspaceStatuses,
      sortBy: 'recent',
      now: 10_000
    })

    expect(result.shouldSwitchToManual).toBe(false)
    expect(Array.from(result.updates)).toEqual([['todo-a', { workspaceStatus: 'doing' }]])
  })

  it('keeps the dropped board position when Manual sort is active', () => {
    const worktreeById = new Map([
      ['todo-a', worktree({ id: 'todo-a', workspaceStatus: 'todo', sortOrder: 3000 })],
      ['doing-a', worktree({ id: 'doing-a', workspaceStatus: 'doing', sortOrder: 2000 })],
      ['doing-b', worktree({ id: 'doing-b', workspaceStatus: 'doing', sortOrder: 1000 })]
    ])

    const result = buildWorkspaceKanbanSidebarDropUpdates({
      worktreeIds: ['todo-a'],
      status: 'doing',
      dropIndex: 1,
      groups: [
        { key: 'todo', worktreeIds: ['todo-a'] },
        { key: 'doing', worktreeIds: ['doing-a', 'doing-b'] }
      ],
      worktreeById,
      workspaceStatuses,
      sortBy: 'manual',
      now: 10_000
    })

    expect(result.shouldSwitchToManual).toBe(true)
    expect(result.updates.get('todo-a')).toEqual({
      workspaceStatus: 'doing',
      manualOrder: 1500
    })
  })
})
