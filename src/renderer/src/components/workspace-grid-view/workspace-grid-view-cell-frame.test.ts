// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { focusWorkspaceGridViewMember } = vi.hoisted(() => ({
  focusWorkspaceGridViewMember: vi.fn()
}))
vi.mock('@/lib/workspace-grid-view-actions', () => ({ focusWorkspaceGridViewMember }))

import {
  WORKSPACE_GRID_VIEW_CELL_ACTION_ATTR,
  focusWorkspaceGridViewCellOnFocus,
  focusWorkspaceGridViewCellOnPointerDown
} from './workspace-grid-view-cell-frame'

function buildCell(): {
  removeButton: HTMLButtonElement
  removeIcon: HTMLElement
  terminal: HTMLElement
} {
  const cell = document.createElement('div')
  const removeButton = document.createElement('button')
  removeButton.setAttribute(WORKSPACE_GRID_VIEW_CELL_ACTION_ATTR, 'remove')
  const removeIcon = document.createElement('span')
  removeButton.append(removeIcon)
  const terminal = document.createElement('textarea')
  cell.append(removeButton, terminal)
  document.body.append(cell)
  return { removeButton, removeIcon, terminal }
}

function markKeyboardFocus(element: Element, keyboard: boolean): void {
  const matches = element.matches.bind(element)
  vi.spyOn(element, 'matches').mockImplementation((selector: string) =>
    selector === ':focus-visible' ? keyboard : matches(selector)
  )
}

describe('grid view cell focus handoff', () => {
  beforeEach(() => {
    focusWorkspaceGridViewMember.mockClear()
    document.body.replaceChildren()
  })

  it('focuses the workspace when the pointer lands in the cell body', () => {
    const { terminal } = buildCell()
    focusWorkspaceGridViewCellOnPointerDown(terminal, 'wt-b')
    expect(focusWorkspaceGridViewMember).toHaveBeenCalledWith('wt-b')
  })

  it('leaves focus alone when the pointer lands on a cell action, even on its icon', () => {
    const { removeIcon } = buildCell()
    focusWorkspaceGridViewCellOnPointerDown(removeIcon, 'wt-b')
    expect(focusWorkspaceGridViewMember).not.toHaveBeenCalled()
  })

  it('moves the workspace when keyboard focus enters the cell', () => {
    const { terminal } = buildCell()
    focusWorkspaceGridViewCellOnFocus(terminal, 'wt-b')
    expect(focusWorkspaceGridViewMember).toHaveBeenCalledWith('wt-b')
  })

  it('moves the workspace when Tab reaches a cell action', () => {
    const { removeButton } = buildCell()
    markKeyboardFocus(removeButton, true)
    focusWorkspaceGridViewCellOnFocus(removeButton, 'wt-b')
    expect(focusWorkspaceGridViewMember).toHaveBeenCalledWith('wt-b')
  })

  it('ignores the focus a mouse click gives a cell action', () => {
    const { removeButton } = buildCell()
    markKeyboardFocus(removeButton, false)
    focusWorkspaceGridViewCellOnFocus(removeButton, 'wt-b')
    expect(focusWorkspaceGridViewMember).not.toHaveBeenCalled()
  })
})
