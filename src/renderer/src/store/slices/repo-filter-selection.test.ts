import { describe, expect, it } from 'vitest'
import { widenFilterRepoIds } from './repo-filter-selection'

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
