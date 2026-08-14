import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
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

  it('routes an upstream project row to the fork clone that tracks it', () => {
    const fork = { ...repo('fork'), upstream: { owner: 'SciPhi-AI', repo: 'R2R' } }
    slugByRepoId.set(
      slugCacheKey(fork.id, settingsForRepoOwner(fork, null)),
      githubRepoIdentityKey({ owner: 'me', repo: 'r2r-mirror' })
    )

    expect(lookupReposBySlugFromCache([fork], null, 'SciPhi-AI/R2R')).toEqual([fork])
  })

  it('prefers the clone that owns the slug over a fork of it', () => {
    const origin = repo('origin')
    const fork = { ...repo('fork'), upstream: { owner: 'SciPhi-AI', repo: 'R2R' } }
    slugByRepoId.set(
      slugCacheKey(origin.id, settingsForRepoOwner(origin, null)),
      githubRepoIdentityKey({ owner: 'SciPhi-AI', repo: 'R2R' })
    )
    slugByRepoId.set(
      slugCacheKey(fork.id, settingsForRepoOwner(fork, null)),
      githubRepoIdentityKey({ owner: 'me', repo: 'r2r-mirror' })
    )

    expect(lookupReposBySlugFromCache([origin, fork], null, 'SciPhi-AI/R2R')).toEqual([origin])
  })

  it('does not route a GHES row to a same-named github.com fork parent', () => {
    const fork = { ...repo('fork'), upstream: { owner: 'acme', repo: 'widgets' } }
    slugByRepoId.set(
      slugCacheKey(fork.id, settingsForRepoOwner(fork, null)),
      githubRepoIdentityKey({ owner: 'me', repo: 'widgets' })
    )

    expect(lookupReposBySlugFromCache([fork], null, 'acme/widgets', 'ghe.example:8443')).toEqual([])
  })

  it('scopes a host-less fork parent to the host the fork itself was cloned from', () => {
    const enterpriseFork = { ...repo('fork'), upstream: { owner: 'acme', repo: 'widgets' } }
    slugByRepoId.set(
      slugCacheKey(enterpriseFork.id, settingsForRepoOwner(enterpriseFork, null)),
      githubRepoIdentityKey({ owner: 'me', repo: 'widgets', host: 'ghe.example:8443' })
    )

    expect(
      lookupReposBySlugFromCache([enterpriseFork], null, 'acme/widgets', 'ghe.example:8443')
    ).toEqual([enterpriseFork])
    expect(lookupReposBySlugFromCache([enterpriseFork], null, 'acme/widgets')).toEqual([])
  })

  it('drops the fork alias while its own origin is unresolved', () => {
    const fork = { ...repo('fork'), upstream: { owner: 'acme', repo: 'widgets' } }

    expect(lookupReposBySlugFromCache([fork], null, 'acme/widgets')).toEqual([])
    slugByRepoId.set(slugCacheKey(fork.id, settingsForRepoOwner(fork, null)), null)
    expect(lookupReposBySlugFromCache([fork], null, 'acme/widgets')).toEqual([])
  })

  it('expires negative slug resolutions so an external GHES login can recover', () => {
    const key = slugCacheKey('enterprise', null)
    rememberRepoSlug(key, null, 1_000)

    expect(readRepoSlugCache(key, 1_000)).toEqual({ hit: true, value: null })
    expect(nextRepoSlugFailureRetryDelay(new Set([key]), 1_000)).toBe(REPO_SLUG_FAILURE_TTL_MS)
    expect(readRepoSlugCache(key, 1_000 + REPO_SLUG_FAILURE_TTL_MS)).toEqual({ hit: false })
  })
})
