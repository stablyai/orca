import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssueInfo } from '../../../../shared/github/pull-request-types'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import { issueCacheKey } from '../github/cache-identity'
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

  it('treats a fresh null as a valid hit even when force is requested', async () => {
    const store = createTestStore()
    const cacheKey = issueCacheKey('/repo/one', 'repo-1', 42)
    store.setState({
      issueCache: {
        [cacheKey]: { data: null, fetchedAt: Date.now() }
      }
    })

    await expect(
      store.getState().fetchIssue('/repo/one', 42, { repoId: 'repo-1', force: true })
    ).resolves.toBeNull()
    expect(mockApi.gh.issue).not.toHaveBeenCalled()
  })

  it('deduplicates a forced caller onto the same in-flight request', async () => {
    const store = createTestStore()
    const pendingIssue = Promise.withResolvers<IssueInfo | null>()
    const issue = { number: 42, title: 'Issue' } as IssueInfo
    mockApi.gh.issue.mockReturnValueOnce(pendingIssue.promise)

    const first = store.getState().fetchIssue('/repo/one', 42, { repoId: 'repo-1' })
    const forced = store.getState().fetchIssue('/repo/one', 42, { repoId: 'repo-1', force: true })
    pendingIssue.resolve(issue)

    await expect(Promise.all([first, forced])).resolves.toEqual([issue, issue])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(1)
  })

  it('persists a source-scoped five-minute null entry after a thrown fetch', async () => {
    const store = createTestStore()
    const sourceContext = githubSourceContext('local', 'source-repo')
    const cacheKey = `${getTaskSourceCacheScope(sourceContext)}::repo-1::42`
    mockApi.gh.issue.mockRejectedValueOnce(new Error('offline'))

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
