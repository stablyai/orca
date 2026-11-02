import { describe, expect, it } from 'vitest'
import { REPO_SEARCH_QUERY_MAX_BYTES, isRepoSearchQueryTooLarge, searchRepos } from './repo-search'
import type { Repo } from '../../../shared/repo-types'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/Users/test/src/orca',
    displayName: 'stablyai/orca',
    badgeColor: '#22c55e',
    addedAt: 0,
    ...overrides
  }
}

describe('repo-search', () => {
  it('keeps display-name matches ahead of path-only matches', () => {
    const repos = [
      makeRepo({ id: '1', displayName: 'misc', path: '/src/orca-tools/misc' }),
      makeRepo({ id: '2', displayName: 'orca', path: '/src/team-a/project' })
    ]

    expect(searchRepos(repos, 'orca').map((repo) => repo.id)).toEqual(['2', '1'])
  })

  it('rejects oversized pasted queries before reading repo names or paths', () => {
    const oversizedQuery = 'secret-repo-search'.repeat(REPO_SEARCH_QUERY_MAX_BYTES)
    const repos = [
      {
        id: 'secret',
        badgeColor: '#111111',
        addedAt: 0,
        get displayName(): string {
          throw new Error('oversized repo searches must not scan display names')
        },
        get path(): string {
          throw new Error('oversized repo searches must not scan paths')
        }
      }
    ] as Repo[]

    expect(isRepoSearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchRepos(repos, oversizedQuery)).toEqual([])
  })

  it('rejects multibyte pasted queries before reading repo names or paths', () => {
    const oversizedQuery = '😀'.repeat(Math.floor(REPO_SEARCH_QUERY_MAX_BYTES / 4) + 1)
    const repos = [
      {
        id: 'secret',
        badgeColor: '#111111',
        addedAt: 0,
        get displayName(): string {
          throw new Error('oversized repo searches must not scan display names')
        },
        get path(): string {
          throw new Error('oversized repo searches must not scan paths')
        }
      }
    ] as Repo[]

    expect(oversizedQuery.length).toBeLessThan(REPO_SEARCH_QUERY_MAX_BYTES)
    expect(isRepoSearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchRepos(repos, oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming', () => {
    const repos = [makeRepo({ id: '1', displayName: 'alpha', path: '/tmp/alpha' })]

    expect(searchRepos(repos, ' '.repeat(REPO_SEARCH_QUERY_MAX_BYTES + 1))).toEqual([])
  })
})
