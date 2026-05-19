import { describe, expect, it } from 'vitest'
import { shouldCommitWorkspaceKanbanAreaSelection } from './use-workspace-kanban-area-selection'

describe('workspace kanban area selection finish', () => {
  it('commits an empty non-additive surface click so selection clears', () => {
    expect(
      shouldCommitWorkspaceKanbanAreaSelection({
        additive: false,
        started: false
      })
    ).toBe(true)
  })

  it('ignores empty additive surface clicks so modifier-click off does not clear', () => {
    expect(
      shouldCommitWorkspaceKanbanAreaSelection({
        additive: true,
        started: false
      })
    ).toBe(false)
  })

  it('commits marquee drags even when additive', () => {
    expect(
      shouldCommitWorkspaceKanbanAreaSelection({
        additive: true,
        started: true
      })
    ).toBe(true)
  })
})
