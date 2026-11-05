import { describe, expect, it } from 'vitest'
import { makeNamedFacets } from './workspace-cleanup-facet.test.fixture'
import { sortWorkspaceCleanupFacets } from './workspace-cleanup-facet-sort'
import type { WorkspaceCleanupSortField } from '../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'

function names(
  rows: ReturnType<typeof makeNamedFacets>[],
  field: WorkspaceCleanupSortField,
  direction: 'asc' | 'desc'
): string[] {
  return sortWorkspaceCleanupFacets(rows, { field, direction }).map((row) => row.displayName)
}

describe('ranked fields', () => {
  it('breaks equal blocker counts by the worst blocker', () => {
    const rows = [
      makeNamedFacets('softest', {
        candidate: { blockers: ['git-status-error'] }
      }),
      makeNamedFacets('hardest', {
        candidate: { blockers: ['main-worktree'] }
      })
    ]
    expect(names(rows, 'blocker-count', 'desc')).toEqual(['hardest', 'softest'])
  })
})
