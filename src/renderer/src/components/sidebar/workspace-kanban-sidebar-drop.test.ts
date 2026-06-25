import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import {
  buildWorkspaceKanbanSidebarDropUpdates,
  clearWorkspaceKanbanSidebarDropTargetVisual,
  getWorkspaceKanbanSidebarDropGroups,
  getWorkspaceKanbanSidebarDropTarget,
  isWorkspaceKanbanSidebarDropPointInBoard,
  updateWorkspaceKanbanSidebarDropTargetVisual
} from './workspace-kanban-sidebar-drop'

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
