import { describe, expect, it, vi } from 'vitest'

import {
  getWorkItemDetailsCacheKey,
  invalidateWorkItemDetailsCacheByMatch,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from './work-item-details-cache'

vi.mock('@/lib/work-items/github/github-work-item-details-cache-events', () => ({
  onGitHubWorkItemDetailsCacheMutation: vi.fn()
}))

const keyArgs = {
  repoId: 'repo-1',
  repoPath: '/home/fixture/widgets',
  type: 'issue' as const,
  number: 12,
  issueSourcePreference: 'origin'
}
const ORIGIN = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
const UPSTREAM = { owner: 'upstream-owner', repo: 'widgets', host: 'github.com' }

describe('issue detail cache repository identity', () => {
  it('invalidates both repository variants after a mutation', () => {
    const originKey = getWorkItemDetailsCacheKey({ ...keyArgs, ownerRepo: ORIGIN })
    const upstreamKey = getWorkItemDetailsCacheKey({ ...keyArgs, ownerRepo: UPSTREAM })
    touchWorkItemDetailsCache(originKey, { details: null, fetchedAt: 0 })
    touchWorkItemDetailsCache(upstreamKey, { details: null, fetchedAt: 0 })

    invalidateWorkItemDetailsCacheByMatch(keyArgs)

    expect(workItemDetailsCache.has(originKey)).toBe(false)
    expect(workItemDetailsCache.has(upstreamKey)).toBe(false)
  })
})
