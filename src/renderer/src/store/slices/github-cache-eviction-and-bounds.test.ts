import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'

describe('createGitHubSlice cache bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.issue.mockReset()
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds restored PR and issue caches, and tells main', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const pr = Object.fromEntries(
      Array.from({ length: 505 }, (_, index) => [
        `repo-id::branch-${index}`,
        { data: makePR({ number: index }), fetchedAt: index }
      ])
    )
    const issue = Object.fromEntries(
      Array.from({ length: 505 }, (_, index) => [
        `repo-id::${index}`,
        { data: { number: index } as never, fetchedAt: index }
      ])
    )
    mockApi.cache.getGitHub.mockResolvedValueOnce({ pr, issue })

    await store.getState().initGitHubCache()

    expect(Object.keys(store.getState().prCache)).toHaveLength(500)
    expect(Object.keys(store.getState().issueCache)).toHaveLength(500)
    expect(store.getState().prCache['repo-id::branch-0']).toBeUndefined()
    expect(store.getState().issueCache['repo-id::0']).toBeUndefined()
    vi.advanceTimersByTime(1000)
    expect(mockApi.cache.setGitHub).toHaveBeenLastCalledWith({
      cache: { pr: store.getState().prCache, issue: store.getState().issueCache }
    })
  })

  it('bounds PR and issue caches as fetches add entries', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    mockApi.gh.refreshPRNow.mockImplementation(({ candidate }) => ({
      kind: 'found',
      pr: makePR({ title: candidate.branch }),
      fetchedAt: Date.now()
    }))
    mockApi.gh.issue.mockImplementation(({ number }) => ({
      number,
      title: `Issue ${number}`,
      state: 'open',
      url: `https://example.com/issues/${number}`
    }))

    for (let index = 0; index < 505; index++) {
      vi.setSystemTime(index)
      await store.getState().fetchPRForBranch(repoPath, `branch-${index}`, {
        force: true,
        repoId
      })
      await store.getState().fetchIssue(repoPath, index, { repoId })
    }

    expect(Object.keys(store.getState().prCache)).toHaveLength(500)
    expect(Object.keys(store.getState().issueCache)).toHaveLength(500)
    expect(store.getState().prCache['repo-id::branch-0']).toBeUndefined()
    expect(store.getState().issueCache['repo-id::0']).toBeUndefined()

    await vi.runOnlyPendingTimersAsync()
  })
})
