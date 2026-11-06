import { describe, expect, it } from 'vitest'
import { REPO_SEARCH_QUERY_MAX_BYTES, isRepoSearchQueryTooLarge, searchRepos } from './repo-search'
import type { Repo } from '../../../shared/repo-types'

describe('repo-search', () => {
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
})
