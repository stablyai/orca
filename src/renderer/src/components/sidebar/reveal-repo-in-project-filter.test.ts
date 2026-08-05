import { describe, expect, it } from 'vitest'
import { revealRepoInProjectFilter } from './reveal-repo-in-project-filter'

describe('revealRepoInProjectFilter', () => {
  it('appends the repo so previously filtered projects stay selected', () => {
    expect(revealRepoInProjectFilter(['repo-a', 'repo-b'], 'repo-c')).toEqual([
      'repo-a',
      'repo-b',
      'repo-c'
    ])
  })

  it('returns null for an empty filter (all repos already visible)', () => {
    expect(revealRepoInProjectFilter([], 'repo-c')).toBeNull()
  })

  it('returns null when the repo is already selected', () => {
    expect(revealRepoInProjectFilter(['repo-a', 'repo-c'], 'repo-c')).toBeNull()
  })

  it('does not mutate the input array', () => {
    const input = ['repo-a']
    revealRepoInProjectFilter(input, 'repo-b')
    expect(input).toEqual(['repo-a'])
  })
})
