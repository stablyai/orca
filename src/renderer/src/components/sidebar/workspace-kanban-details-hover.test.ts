import { describe, expect, it } from 'vitest'
import { getWorkspaceKanbanDetailsHoverOpenState } from './workspace-kanban-details-hover'

describe('getWorkspaceKanbanDetailsHoverOpenState', () => {
  it('keeps the details hover closed while the context menu is open', () => {
    expect(
      getWorkspaceKanbanDetailsHoverOpenState({
        contextMenuOpen: true,
        requestedOpen: true
      })
    ).toBe(false)
  })

  it('follows hover requests when the context menu is closed', () => {
    expect(
      getWorkspaceKanbanDetailsHoverOpenState({
        contextMenuOpen: false,
        requestedOpen: true
      })
    ).toBe(true)
    expect(
      getWorkspaceKanbanDetailsHoverOpenState({
        contextMenuOpen: false,
        requestedOpen: false
      })
    ).toBe(false)
  })
})
