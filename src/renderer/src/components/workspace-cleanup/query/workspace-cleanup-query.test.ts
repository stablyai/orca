import { expect, it } from 'vitest'
import { createDefaultWorkspaceCleanupFilterState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'
import { queryWorkspaceCleanupCandidates } from './workspace-cleanup-query'

it.each(['name', 'last-activity'] as const)(
  'sorts an older candidate without a display name by %s',
  (field) => {
    const named = makeFacetCandidate({
      worktreeId: 'named',
      displayName: 'Beta',
      lastActivityAt: 0
    })
    const unnamed = makeFacetCandidate({ worktreeId: 'unnamed', lastActivityAt: 0 })
    Reflect.deleteProperty(unnamed, 'displayName')

    const result = queryWorkspaceCleanupCandidates([named, unnamed], {
      filters: createDefaultWorkspaceCleanupFilterState(),
      sort: { field, direction: 'asc' }
    })

    expect(result.rows.map((row) => [row.worktreeId, row.displayName])).toEqual([
      ['unnamed', ''],
      ['named', 'Beta']
    ])
  }
)
