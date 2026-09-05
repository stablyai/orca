import { describe, expect, it, vi } from 'vitest'
import { includeReposInFilter, widenFilterRepoIds } from './repo-filter-selection'

describe('widenFilterRepoIds', () => {
  it('returns null when the filter is empty (no filter to widen)', () => {
    expect(widenFilterRepoIds([], ['repo-1'])).toBeNull()
  })

  it('returns null when all repoIds are already included', () => {
    expect(widenFilterRepoIds(['repo-1', 'repo-2'], ['repo-1'])).toBeNull()
  })

  it('appends only the missing repoIds, preserving order and without duplicates', () => {
    expect(widenFilterRepoIds(['repo-1'], ['repo-1', 'repo-2', 'repo-3'])).toEqual([
      'repo-1',
      'repo-2',
      'repo-3'
    ])
  })

  it('appends a repeated missing id only once', () => {
    expect(widenFilterRepoIds(['repo-1'], ['repo-2', 'repo-2'])).toEqual(['repo-1', 'repo-2'])
  })
})

describe('includeReposInFilter', () => {
  it('sets the widened filter only when something is missing', () => {
    const setFilterRepoIds = vi.fn()
    includeReposInFilter({ filterRepoIds: ['repo-1'], setFilterRepoIds }, ['repo-2'])
    expect(setFilterRepoIds).toHaveBeenCalledWith(['repo-1', 'repo-2'])
  })

  it('does nothing when the filter is inactive or already covers the ids', () => {
    const setFilterRepoIds = vi.fn()
    includeReposInFilter({ filterRepoIds: [], setFilterRepoIds }, ['repo-2'])
    includeReposInFilter({ filterRepoIds: ['repo-2'], setFilterRepoIds }, ['repo-2'])
    expect(setFilterRepoIds).not.toHaveBeenCalled()
  })
})
