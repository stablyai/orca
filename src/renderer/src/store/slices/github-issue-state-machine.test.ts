import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistGitHubCacheChanges } from '../github/cache-persistence'

import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

import {
  createTestStore,
  githubSourceContext,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'

describe('createGitHubSlice.fetchIssue state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.issue.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('persists a source-scoped five-minute null entry after a thrown fetch', async () => {
    const store = createTestStore()
    const sourceContext = githubSourceContext('local', 'source-repo')
    const cacheKey = `${getTaskSourceCacheScope(sourceContext)}::repo-1::42`
    mockApi.gh.issue.mockRejectedValueOnce(new Error('offline'))
    persistGitHubCacheChanges(store)

    await expect(
      store.getState().fetchIssue('/repo/one', 42, { repoId: 'repo-1', sourceContext })
    ).resolves.toBeNull()

    const failedEntry = store.getState().issueCache[cacheKey]
    expect(failedEntry?.data).toBeNull()
    expect(Date.now() - (failedEntry?.fetchedAt ?? 0)).toBeLessThan(300_000)
    expect(mockApi.cache.setGitHub).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mockApi.cache.setGitHub).toHaveBeenCalledWith({
      cache: {
        pr: store.getState().prCache,
        issue: store.getState().issueCache
      }
    })

    await expect(
      store.getState().fetchIssue('/repo/one', 42, { repoId: 'repo-1', sourceContext, force: true })
    ).resolves.toBeNull()
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(1)
  })
})
