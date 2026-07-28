import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'
import {
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
})
