import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import {
  createHostedReviewSlice,
  getHostedReviewCacheKey,
  refreshHostedReviewCard
} from './hosted-review'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'

const runtimeRpc = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtimeRpc.callRuntimeRpc,
  getActiveRuntimeTarget: (
    settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined
  ) => {
    const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
    return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  }
}))

const mockApi = {
  hostedReview: {
    forBranch: vi.fn()
  }
}

globalThis.window = { api: mockApi } as never

function makeStore(settings: AppState['settings'] = null) {
  return create<Pick<AppState, 'hostedReviewCache' | 'fetchHostedReviewForBranch' | 'settings'>>()(
    (...args) => ({
      settings,
      ...createHostedReviewSlice(...(args as Parameters<typeof createHostedReviewSlice>))
    })
  )
}

const review: HostedReviewInfo = {
  provider: 'gitlab',
  number: 5,
  title: 'Shared MR status',
  state: 'open',
  url: 'https://gitlab.com/g/p/-/merge_requests/5',
  status: 'success',
  updatedAt: '2026-05-10T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

describe('hosted review slice', () => {
  beforeEach(() => {
    mockApi.hostedReview.forBranch.mockReset()
    runtimeRpc.callRuntimeRpc.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches and caches branch review status through the common IPC surface', async () => {
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(review)
    const store = makeStore()

    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/gitlab', {
        linkedGitLabMR: 5
      })
    ).resolves.toEqual(review)
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/gitlab')
    ).resolves.toEqual(review)

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith({
      repoPath: '/repo',
      branch: 'feature/gitlab',
      linkedGitHubPR: null,
      linkedGitLabMR: 5,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
  })

  it('routes active runtime review lookups through runtime RPC', async () => {
    runtimeRpc.callRuntimeRpc.mockResolvedValueOnce(review)
    const store = makeStore({
      activeRuntimeEnvironmentId: 'env-win'
    } as AppState['settings'])

    await expect(
      store.getState().fetchHostedReviewForBranch('C:\\repo', 'feature/windows', {
        linkedGitHubPR: 12
      })
    ).resolves.toEqual(review)

    expect(mockApi.hostedReview.forBranch).not.toHaveBeenCalled()
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-win' },
      'hostedReview.forBranch',
      {
        repo: 'C:\\repo',
        repoPath: 'C:\\repo',
        branch: 'feature/windows',
        linkedGitHubPR: 12,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      },
      { timeoutMs: 30_000 }
    )
  })

  it('forces card refresh with repo-scoped identity and linked review ids', async () => {
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    await refreshHostedReviewCard(fetchHostedReviewForBranch, {
      repoPath: '/repo',
      repoId: 'repo-id',
      branch: 'feature/test',
      linkedGitHubPR: null,
      linkedGitLabMR: 33
    })
    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith('/repo', 'feature/test', {
      force: true,
      repoId: 'repo-id',
      linkedGitHubPR: null,
      linkedGitLabMR: 33,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
  })

  it('refetches a fresh null branch result when a linked PR hint is later available', async () => {
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(null).mockResolvedValueOnce(review)
    const store = makeStore()

    await expect(store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr')).resolves.toBe(
      null
    )
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42
      })
    ).resolves.toEqual(review)

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
  })

  it('honors the cache TTL after a linked PR miss with the same hint', async () => {
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
    const store = makeStore()

    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42
      })
    ).resolves.toBeNull()
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42
      })
    ).resolves.toBeNull()

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
  })

  it('does not dedupe a linked PR hint onto a weaker in-flight branch lookup', async () => {
    let resolveBranchLookup: (value: null) => void = () => {}
    const branchLookup = new Promise<null>((resolve) => {
      resolveBranchLookup = resolve
    })
    mockApi.hostedReview.forBranch.mockReturnValueOnce(branchLookup).mockResolvedValueOnce(review)
    const store = makeStore()

    const plainFetch = store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr')
    const linkedFetch = store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
      linkedGitHubPR: 42
    })

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    resolveBranchLookup(null)
    await expect(plainFetch).resolves.toBeNull()
    await expect(linkedFetch).resolves.toEqual(review)
  })

  it('dedupes repeated linked PR retries while a stronger lookup is in flight', async () => {
    let resolveLinkedLookup: (value: typeof review) => void = () => {}
    const linkedLookup = new Promise<typeof review>((resolve) => {
      resolveLinkedLookup = resolve
    })
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(null).mockReturnValueOnce(linkedLookup)
    const store = makeStore()

    await expect(store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr')).resolves.toBe(
      null
    )

    const firstLinkedFetch = store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
      linkedGitHubPR: 42
    })
    const secondLinkedFetch = store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
      linkedGitHubPR: 42
    })

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    resolveLinkedLookup(review)
    await expect(firstLinkedFetch).resolves.toEqual(review)
    await expect(secondLinkedFetch).resolves.toEqual(review)
  })

  it('serves stale hosted review metadata while revalidating in the background', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const updatedReview: HostedReviewInfo = {
      ...review,
      title: 'Updated linked PR status',
      status: 'failure',
      updatedAt: '2026-05-10T00:01:01.000Z'
    }
    let resolveRefresh: (value: typeof updatedReview) => void = () => {}
    const refresh = new Promise<typeof updatedReview>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.hostedReview.forBranch
      .mockResolvedValueOnce(review)
      .mockReturnValueOnce(refresh as Promise<HostedReviewInfo>)
    const store = makeStore()

    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42
      })
    ).resolves.toEqual(review)
    vi.setSystemTime(60_001)
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42,
        staleWhileRevalidate: true
      })
    ).resolves.toEqual(review)
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42,
        staleWhileRevalidate: true
      })
    ).resolves.toEqual(review)

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    const cacheKey = getHostedReviewCacheKey('/repo', 'feature/pr')
    expect(store.getState().hostedReviewCache[cacheKey]?.data).toEqual(review)

    resolveRefresh(updatedReview)
    await refresh
    await Promise.resolve()

    expect(store.getState().hostedReviewCache[cacheKey]?.data).toEqual(updatedReview)
  })

  it('does not serve stale metadata when a stronger linked PR hint changes the lookup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const linkedReview: HostedReviewInfo = {
      ...review,
      provider: 'github',
      number: 42,
      title: 'Exact linked PR',
      url: 'https://github.com/acme/orca/pull/42'
    }
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(review).mockResolvedValueOnce(linkedReview)
    const store = makeStore()

    await expect(store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr')).resolves.toBe(
      review
    )
    vi.setSystemTime(60_001)
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42,
        staleWhileRevalidate: true
      })
    ).resolves.toEqual(linkedReview)

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
  })
})
