// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import {
  isWorkspaceBoardKeepOpenTarget,
  useWorkspaceKanbanOutsideDismiss
} from './use-workspace-kanban-outside-dismiss'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function mountBoardListener({
  open = true,
  preserveOpenForMenu = false
}: { open?: boolean; preserveOpenForMenu?: boolean } = {}) {
  const sheet = document.createElement('div')
  sheet.setAttribute('data-slot', 'sheet-content')
  const board = document.createElement('div')
  sheet.append(board)
  document.body.append(sheet)
  vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 36, 800, 600))
  const onOpenChange = vi.fn()
  const hook = renderHook(() =>
    useWorkspaceKanbanOutsideDismiss({
      open,
      boardRef: { current: board },
      preserveOpenForMenu,
      onOpenChange
    })
  )
  return { board, onOpenChange, unmount: hook.unmount }
}

function sidebarTab(): HTMLButtonElement {
  const tab = document.createElement('button')
  tab.setAttribute('data-workspace-board-dismiss', '')
  document.body.append(tab)
  return tab
}

describe('workspace kanban outside dismiss keep-open targets', () => {
  it.each(['data-sonner-toast', 'data-contextual-tour-panel'])(
    'keeps the board open for a child of %s',
    (attribute) => {
      const panel = document.createElement('div')
      panel.setAttribute(attribute, '')
      const action = document.createElement('button')
      panel.append(action)
      expect(isWorkspaceBoardKeepOpenTarget(action)).toBe(true)
    }
  )

  it('does not keep the board open for generic outside content', () => {
    expect(isWorkspaceBoardKeepOpenTarget(document.createElement('div'))).toBe(false)
  })
})

describe('workspace kanban outside dismiss', () => {
  it.each(['pointerdown', 'click'])(
    'closes from a sidebar tab inside a portalled menu on %s',
    (eventType) => {
      const { onOpenChange } = mountBoardListener()
      const menu = document.createElement('div')
      menu.setAttribute('data-slot', 'dropdown-menu-content')
      const tab = sidebarTab()
      const icon = document.createElement('span')
      tab.append(icon)
      menu.append(tab)
      document.body.append(menu)

      icon.dispatchEvent(new MouseEvent(eventType, { bubbles: true }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
    }
  )

  it('dismisses for an explicit sidebar tab while a board menu is open', () => {
    const { onOpenChange } = mountBoardListener({ preserveOpenForMenu: true })

    sidebarTab().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('preserves board content, unrelated menus and the existing outside bounds', () => {
    const { board, onOpenChange } = mountBoardListener()
    const markerInsideBoard = sidebarTab()
    board.append(markerInsideBoard)
    markerInsideBoard.click()
    const menu = document.createElement('div')
    menu.setAttribute('data-slot', 'dropdown-menu-content')
    document.body.append(menu)
    menu.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 950, clientY: 80 })
    )
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 500, clientY: 18 })
    )
    expect(onOpenChange).not.toHaveBeenCalled()

    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 950, clientY: 80 })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('preserves an open board menu for ordinary outside pointer events', () => {
    const { onOpenChange } = mountBoardListener({ preserveOpenForMenu: true })
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 950, clientY: 80 })
    )
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('stops listening after unmount and while the board is closed', () => {
    const mounted = mountBoardListener()
    mounted.unmount()
    const closed = mountBoardListener({ open: false })
    const tab = sidebarTab()
    tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    tab.click()
    expect(mounted.onOpenChange).not.toHaveBeenCalled()
    expect(closed.onOpenChange).not.toHaveBeenCalled()
  })
})
