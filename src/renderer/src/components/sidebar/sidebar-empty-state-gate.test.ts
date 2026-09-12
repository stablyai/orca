import { describe, expect, it } from 'vitest'
import { shouldFiltersHideAllRows } from './sidebar-empty-state-gate'

const NOTHING_ELSE = {
  visibleWorktreeCount: 0,
  placeholderRepoCount: 0,
  importedWorktreeCardCount: 0
}

describe('Clear Filters empty state', () => {
  it('does not replace a folder-only sidebar when a filter is active', () => {
    // The reported symptom reached by a second path: with any filter active
    // (host scope counts), a folder-only account saw Clear Filters instead of
    // its workspaces — under every Group by mode, including Project.
    expect(
      shouldFiltersHideAllRows({
        ...NOTHING_ELSE,
        hasFilters: true,
        visibleFolderWorkspaceCount: 1
      })
    ).toBe(false)
  })

  it('still wins when filters hid every row kind', () => {
    expect(
      shouldFiltersHideAllRows({
        ...NOTHING_ELSE,
        hasFilters: true,
        visibleFolderWorkspaceCount: 0
      })
    ).toBe(true)
  })

  it('never wins without active filters', () => {
    expect(
      shouldFiltersHideAllRows({
        ...NOTHING_ELSE,
        hasFilters: false,
        visibleFolderWorkspaceCount: 0
      })
    ).toBe(false)
  })

  it('defers to worktrees, placeholders and imported cards as before', () => {
    for (const key of [
      'visibleWorktreeCount',
      'placeholderRepoCount',
      'importedWorktreeCardCount'
    ] as const) {
      expect(
        shouldFiltersHideAllRows({
          ...NOTHING_ELSE,
          hasFilters: true,
          visibleFolderWorkspaceCount: 0,
          [key]: 1
        })
      ).toBe(false)
    }
  })
})
