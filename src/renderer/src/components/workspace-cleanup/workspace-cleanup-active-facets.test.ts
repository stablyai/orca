import { describe, expect, it } from 'vitest'
import { createDefaultWorkspaceCleanupFilterState } from '../../../../shared/workspace-cleanup-filter-model'
import { normalizeWorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'
import {
  hasActiveWorkspaceCleanupFilters,
  listActiveWorkspaceCleanupFacetGroups
} from './workspace-cleanup-active-facets'

describe('listActiveWorkspaceCleanupFacetGroups', () => {
  it('reports nothing for the default state', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    expect(listActiveWorkspaceCleanupFacetGroups(filters)).toEqual([])
    expect(hasActiveWorkspaceCleanupFilters(filters)).toBe(false)
  })

  it('names each edited group', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.activity.idleMinDays = 45
    filters.git.states = ['dirty']
    expect(listActiveWorkspaceCleanupFacetGroups(filters)).toEqual(['activity', 'git'])
  })

  it('treats multi-select order as meaningless', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.review.states = ['merged', 'closed']
    const reordered = createDefaultWorkspaceCleanupFilterState()
    reordered.review.states = ['closed', 'merged']
    expect(listActiveWorkspaceCleanupFacetGroups(filters)).toEqual(
      listActiveWorkspaceCleanupFacetGroups(reordered)
    )
  })

  it('counts a text query as an active filter without naming a group', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.query = ' alpha '
    expect(listActiveWorkspaceCleanupFacetGroups(filters)).toEqual([])
    expect(hasActiveWorkspaceCleanupFilters(filters)).toBe(true)
  })

  it('drops retired verdict filters and recovers safety as inactive', () => {
    const browse = normalizeWorkspaceCleanupBrowseState({
      filters: { safety: { tiers: ['ready'], selectableOnly: true } },
      sort: { field: 'tier', direction: 'desc' }
    })

    expect(listActiveWorkspaceCleanupFacetGroups(browse.filters)).not.toContain('safety')
    expect(browse.sort).toEqual({ field: 'last-activity', direction: 'desc' })
  })
})
