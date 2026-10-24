import { describe, expect, it } from 'vitest'
import { filterRepoLucideIconOptions } from './repo-lucide-icon-search'

const SAMPLE = [
  { name: 'Globe', label: 'Web' },
  { name: 'Guitar', label: 'Guitar' },
  { name: 'GitBranch', label: 'Git' }
] as const

describe('filterRepoLucideIconOptions', () => {
  it('returns all options for an empty query', () => {
    expect(filterRepoLucideIconOptions(SAMPLE, '')).toEqual([...SAMPLE])
    expect(filterRepoLucideIconOptions(SAMPLE, '   ')).toEqual([...SAMPLE])
  })

  it('matches label and lucide name case-insensitively', () => {
    expect(filterRepoLucideIconOptions(SAMPLE, 'web')).toEqual([SAMPLE[0]])
    expect(filterRepoLucideIconOptions(SAMPLE, 'git')).toEqual([SAMPLE[2]])
    expect(filterRepoLucideIconOptions(SAMPLE, 'GUITAR')).toEqual([SAMPLE[1]])
  })

  it('returns no matches when nothing fits', () => {
    expect(filterRepoLucideIconOptions(SAMPLE, 'zzzz')).toEqual([])
  })
})
