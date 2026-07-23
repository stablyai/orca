import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'
import {
  MAX_REPO_SLUG_CACHE_ENTRIES,
  REPO_SLUG_CACHE_MAX_ENTRY_BYTES,
  REPO_SLUG_FAILURE_TTL_MS,
  clearRepoSlugCacheValues,
  nextRepoSlugFailureRetryDelay,
  readRepoSlugCache,
  rememberRepoSlug,
  lookupReposBySlugFromCache,
  settingsForRepoOwner,
  slugByRepoId,
  slugCacheKey
} from './repo-slug-cache'

function repo(id: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId: 'local'
  }
}

describe('repo slug cache host identity', () => {
  beforeEach(() => clearRepoSlugCacheValues())

  it('does not route a GHES project row to a same-named github.com repo', () => {
    const dotCom = repo('dotcom')
    const enterprise = repo('enterprise')
    for (const [candidate, host] of [
      [dotCom, 'github.com'],
      [enterprise, 'ghe.example:8443']
    ] as const) {
      slugByRepoId.set(
        slugCacheKey(candidate.id, settingsForRepoOwner(candidate, null)),
        githubRepoIdentityKey({ owner: 'acme', repo: 'widgets', host })
      )
    }

    expect(lookupReposBySlugFromCache([dotCom, enterprise], null, 'acme/widgets')).toEqual([dotCom])
    expect(
      lookupReposBySlugFromCache([dotCom, enterprise], null, 'acme/widgets', 'ghe.example:8443')
    ).toEqual([enterprise])
  })

  it('expires negative slug resolutions so an external GHES login can recover', () => {
    const key = slugCacheKey('enterprise', null)
    rememberRepoSlug(key, null, 1_000)

    expect(readRepoSlugCache(key, 1_000)).toEqual({ hit: true, value: null })
    expect(nextRepoSlugFailureRetryDelay(new Set([key]), 1_000)).toBe(REPO_SLUG_FAILURE_TTL_MS)
    expect(readRepoSlugCache(key, 1_000 + REPO_SLUG_FAILURE_TTL_MS)).toEqual({ hit: false })
  })

  it('retains only the newest repo slug results after pathological repo churn', () => {
    for (let index = 0; index <= MAX_REPO_SLUG_CACHE_ENTRIES; index += 1) {
      rememberRepoSlug(`local:repo-${index}`, `owner/repo-${index}`)
    }

    expect(slugByRepoId).toHaveLength(MAX_REPO_SLUG_CACHE_ENTRIES)
    expect(readRepoSlugCache('local:repo-0')).toEqual({ hit: false })
    expect(readRepoSlugCache('local:repo-1')).toEqual({
      hit: true,
      value: 'owner/repo-1'
    })
    expect(readRepoSlugCache(`local:repo-${MAX_REPO_SLUG_CACHE_ENTRIES}`)).toEqual({
      hit: true,
      value: `owner/repo-${MAX_REPO_SLUG_CACHE_ENTRIES}`
    })
  })

  it('does not refresh insertion order when an existing slug changes', () => {
    for (let index = 0; index < MAX_REPO_SLUG_CACHE_ENTRIES; index += 1) {
      rememberRepoSlug(`local:repo-${index}`, `owner/repo-${index}`)
    }
    rememberRepoSlug('local:repo-0', 'owner/renamed')
    rememberRepoSlug('local:overflow', 'owner/overflow')

    expect(readRepoSlugCache('local:repo-0')).toEqual({ hit: false })
    expect(readRepoSlugCache('local:repo-1')).toEqual({
      hit: true,
      value: 'owner/repo-1'
    })
  })

  it('accepts an exact-byte entry and rejects an oversized entry', () => {
    const key = 'local:repo-1'
    const exactValue = 'x'.repeat(REPO_SLUG_CACHE_MAX_ENTRY_BYTES - key.length)

    rememberRepoSlug(key, exactValue)
    rememberRepoSlug('local:oversized', 'x'.repeat(REPO_SLUG_CACHE_MAX_ENTRY_BYTES))

    expect(readRepoSlugCache(key)).toEqual({ hit: true, value: exactValue })
    expect(readRepoSlugCache('local:oversized')).toEqual({ hit: false })
  })
})
