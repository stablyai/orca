import { describe, expect, it } from 'vitest'
import { createDefaultWorkspaceCleanupFilterState } from '../../../../shared/workspace-cleanup-filter-model'
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
})
