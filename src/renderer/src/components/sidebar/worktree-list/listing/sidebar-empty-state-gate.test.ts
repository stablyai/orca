import { describe, expect, it } from 'vitest'
import { shouldFiltersHideAllRows } from './sidebar-empty-state-gate'

describe('shouldFiltersHideAllRows', () => {
  it('hides surviving empty headers behind Clear Filters when active filters hide existing workspaces', () => {
    expect(
      shouldFiltersHideAllRows({
        hasFilters: true,
        totalWorkspaceCount: 3,
        visibleWorktreeCount: 0,
        visibleFolderWorkspaceCount: 0,
        placeholderRepoCount: 0,
        importedWorktreeCardCount: 0,
        visibleProjectGroupCount: 2
      })
    ).toBe(true)
  })

  it('keeps newly created empty project groups visible when zero workspaces exist even if a filter toggle is active', () => {
    expect(
      shouldFiltersHideAllRows({
        hasFilters: true,
        totalWorkspaceCount: 0,
        visibleWorktreeCount: 0,
        visibleFolderWorkspaceCount: 0,
        placeholderRepoCount: 0,
        importedWorktreeCardCount: 0,
        visibleProjectGroupCount: 1
      })
    ).toBe(false)
  })
})
