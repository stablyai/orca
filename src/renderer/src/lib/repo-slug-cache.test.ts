import { beforeEach, describe, expect, it } from 'vitest'

import '../../../shared/github/repository-identity-key'
import {
  REPO_SLUG_FAILURE_TTL_MS,
  clearRepoSlugCacheValues,
  nextRepoSlugFailureRetryDelay,
  readRepoSlugCache,
  rememberRepoSlug,
  slugCacheKey
} from './repo-slug-cache'

describe('repo slug cache host identity', () => {
  beforeEach(() => clearRepoSlugCacheValues())

  it('expires negative slug resolutions so an external GHES login can recover', () => {
    const key = slugCacheKey('enterprise', { kind: 'local' })
    rememberRepoSlug(key, null, 1_000)

    expect(readRepoSlugCache(key, 1_000)).toEqual({ hit: true, value: null })
    expect(nextRepoSlugFailureRetryDelay(new Set([key]), 1_000)).toBe(REPO_SLUG_FAILURE_TTL_MS)
    expect(readRepoSlugCache(key, 1_000 + REPO_SLUG_FAILURE_TTL_MS)).toEqual({ hit: false })
  })
})
