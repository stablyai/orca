import { describe, expect, it } from 'vitest'
import {
  getWorkspaceStatusFilterLabel,
  toggleFilterWorkspaceStatus
} from './SidebarWorkspaceStatusFilterSection'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'

const STATUSES: readonly WorkspaceStatusDefinition[] = DEFAULT_WORKSPACE_STATUSES
const ALL_IDS = STATUSES.map((status) => status.id)

describe('toggleFilterWorkspaceStatus', () => {
  it('selects a status from the empty "all" selection', () => {
    expect(toggleFilterWorkspaceStatus([], STATUSES, 'completed')).toEqual(['completed'])
  })

  it('adds a second status in catalog order, not click order', () => {
    expect(toggleFilterWorkspaceStatus(['completed'], STATUSES, 'todo')).toEqual([
      'todo',
      'completed'
    ])
  })

  it('deselects a status that was selected', () => {
    expect(toggleFilterWorkspaceStatus(['todo', 'completed'], STATUSES, 'todo')).toEqual([
      'completed'
    ])
  })

  it('collapses back to "all" when the last selected status is deselected', () => {
    // Otherwise the click would empty the sidebar from inside the menu.
    expect(toggleFilterWorkspaceStatus(['todo'], STATUSES, 'todo')).toEqual([])
  })

  it('collapses back to "all" when every status ends up selected', () => {
    // Selecting everything narrows nothing, so it must not read as a filter.
    const allButLast = ALL_IDS.slice(0, -1)
    expect(toggleFilterWorkspaceStatus(allButLast, STATUSES, ALL_IDS.at(-1)!)).toEqual([])
  })

  it('drops stale ids while toggling instead of carrying them forward', () => {
    expect(toggleFilterWorkspaceStatus(['deleted-custom'], STATUSES, 'todo')).toEqual(['todo'])
  })

  it('returns the same array identity for a no-op on an already-empty selection', () => {
    const empty: string[] = []
    expect(toggleFilterWorkspaceStatus(empty, [STATUSES[0]], STATUSES[0].id)).toBe(empty)
  })
})

describe('getWorkspaceStatusFilterLabel', () => {
  it('reads "All statuses" for an empty selection', () => {
    expect(getWorkspaceStatusFilterLabel(STATUSES, [])).toBe('All statuses')
  })

  it('reads "All statuses" when every status is selected', () => {
    expect(getWorkspaceStatusFilterLabel(STATUSES, ALL_IDS)).toBe('All statuses')
  })

  it('names the single selected status', () => {
    expect(getWorkspaceStatusFilterLabel(STATUSES, ['completed'])).toBe('Done')
  })

  it('counts a multi-status selection', () => {
    expect(getWorkspaceStatusFilterLabel(STATUSES, ['todo', 'completed'])).toBe('2 statuses')
  })

  it('ignores stale ids when counting', () => {
    // A deleted custom status must not inflate the label past what filters.
    expect(getWorkspaceStatusFilterLabel(STATUSES, ['todo', 'deleted-custom'])).toBe('Todo')
  })
})
