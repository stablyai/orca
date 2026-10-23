// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  isWorkspaceBoardKeepOpenTarget,
  useWorkspaceKanbanOutsideDismiss
} from './use-workspace-kanban-outside-dismiss'

class FakeNode {
  parentElement: FakeElement | null = null
}

class FakeElement extends FakeNode {
  private readonly attributes: ReadonlySet<string>

  constructor(attributes: readonly string[] = [], parentElement: FakeElement | null = null) {
    super()
    this.attributes = new Set(attributes)
    this.parentElement = parentElement
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) {
      return this
    }
    return this.parentElement?.closest(selector) ?? null
  }

  private matches(selector: string): boolean {
    return selector
      .split(',')
      .map((part) => part.trim())
      .some((part) => this.attributes.has(part))
  }
}

describe('workspace kanban outside dismiss keep-open targets', () => {
  beforeEach(() => {
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('Element', FakeElement)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the board open when a Sonner toast action is clicked', () => {
    const toast = new FakeElement(['[data-sonner-toast]'])
    const action = new FakeElement([], toast)

    expect(isWorkspaceBoardKeepOpenTarget(action as unknown as EventTarget)).toBe(true)
  })

  it('keeps the board open when the contextual tour panel is clicked', () => {
    const panel = new FakeElement(['[data-contextual-tour-panel]'])
    const nextButton = new FakeElement([], panel)

    expect(isWorkspaceBoardKeepOpenTarget(nextButton as unknown as EventTarget)).toBe(true)
  })

  it('does not keep the board open for generic outside content', () => {
    const target = new FakeElement()

    expect(isWorkspaceBoardKeepOpenTarget(target as unknown as EventTarget)).toBe(false)
  })
})

describe('workspace kanban outside dismiss', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('closes the board from a right-sidebar tab, even inside a portalled menu', () => {
    const sheet = document.createElement('div')
    sheet.setAttribute('data-slot', 'sheet-content')
    const board = document.createElement('div')
    sheet.append(board)
    const menu = document.createElement('div')
    menu.setAttribute('data-slot', 'dropdown-menu-content')
    const tab = document.createElement('div')
    tab.setAttribute('data-workspace-board-dismiss', '')
    menu.append(tab)
    document.body.append(sheet, menu)
    const onOpenChange = vi.fn()
    renderHook(() =>
      useWorkspaceKanbanOutsideDismiss({
        open: true,
        boardRef: { current: board },
        preserveOpenForMenu: false,
        onOpenChange
      })
    )

    menu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onOpenChange).not.toHaveBeenCalled()
    tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
