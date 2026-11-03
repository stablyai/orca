import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createHostedReviewSlice } from './hosted-review'
import './hosted-review-card-refresh'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import { HostedReviewCreationEligibilityTimeoutError } from './hosted-review-cache-state'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import '../../../../shared/constants'

const runtimeRpc = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: runtimeRpc.callRuntimeRpc }))

const mockApi = {
  hostedReview: {
    forBranch: vi.fn(),
    getCreationEligibility: vi.fn(),
    create: vi.fn(),
    createStacked: vi.fn()
  }
}

globalThis.window = { api: mockApi } as never

function makeStore(settings: AppState['settings'] = null) {
  return create<
    Pick<
      AppState,
      | 'hostedReviewCache'
      | 'fetchHostedReviewForBranch'
      | 'getHostedReviewCreationEligibility'
      | 'createHostedReview'
      | 'createStackedHostedReview'
      | 'settings'
      | 'repos'
      | 'prCache'
    >
  >()((...args) => ({
    settings,
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null } as AppState['repos'][number]],
    prCache: {},
    ...createHostedReviewSlice(...(args as Parameters<typeof createHostedReviewSlice>))
  }))
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

const githubReview: HostedReviewInfo = {
  provider: 'github',
  number: 12,
  title: 'Branch PR',
  state: 'open',
  url: 'https://github.com/acme/orca/pull/12',
  status: 'success',
  updatedAt: '2026-05-10T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

describe('hosted review slice', () => {
  beforeEach(() => {
    mockApi.hostedReview.forBranch.mockReset()
    mockApi.hostedReview.getCreationEligibility.mockReset()
    mockApi.hostedReview.create.mockReset()
    mockApi.hostedReview.createStacked.mockReset()
    runtimeRpc.callRuntimeRpc.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears stale GitHub PR cache when branch review lookup finds a non-GitHub review', async () => {
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(review)
    const store = makeStore()
    store.setState({
      prCache: {
        'repo-1::feature/gitlab': {
          data: {
            number: 12,
            title: 'Old GitHub PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/12',
            checksStatus: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN',
            headSha: 'head-oid'
          },
          fetchedAt: 1
        },
        '/repo::feature/gitlab': {
          data: {
            number: 99,
            title: 'Old path-scoped GitHub PR',
            state: 'closed',
            url: 'https://github.com/acme/orca/pull/99',
            checksStatus: 'failure',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN',
            headSha: 'old-head-oid'
          },
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/gitlab')
    ).resolves.toEqual(review)

    expect(store.getState().prCache['repo-1::feature/gitlab']).toBeUndefined()
    expect(store.getState().prCache['/repo::feature/gitlab']).toBeUndefined()
  })

  it('rejects a never-settling local eligibility probe after the timeout', async () => {
    vi.useFakeTimers()
    // A hung git/gh subprocess never resolves; the store must not wait forever.
    mockApi.hostedReview.getCreationEligibility.mockReturnValueOnce(new Promise(() => {}))
    const store = makeStore()

    const pending = store.getState().getHostedReviewCreationEligibility({
      repoPath: '/repo',
      branch: 'feature/create-pr',
      base: 'main'
    })
    const assertion = expect(pending).rejects.toBeInstanceOf(
      HostedReviewCreationEligibilityTimeoutError
    )
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reuse an old-head request after the branch advances', async () => {
    const mergedAtHead: HostedReviewInfo = {
      ...githubReview,
      state: 'merged',
      headSha: 'aaaaaaa'
    }
    let resolveOldHead!: (value: HostedReviewInfo | null) => void
    mockApi.hostedReview.forBranch
      .mockResolvedValueOnce(mergedAtHead)
      .mockImplementationOnce(
        () =>
          new Promise<HostedReviewInfo | null>((resolve) => {
            resolveOldHead = resolve
          })
      )
      .mockResolvedValueOnce(null)
    const store = makeStore()
    const fetch = store.getState().fetchHostedReviewForBranch
    await fetch('/repo', 'feature/inflight-head', { currentHeadOid: 'aaaaaaa' })
    const oldFetch = fetch('/repo', 'feature/inflight-head', {
      force: true,
      currentHeadOid: 'aaaaaaa'
    })
    const newFetch = fetch('/repo', 'feature/inflight-head', {
      staleWhileRevalidate: true,
      currentHeadOid: 'bbbbbbb'
    })
    resolveOldHead(mergedAtHead)

    await expect(newFetch).resolves.toBeNull()
    await expect(oldFetch).resolves.toEqual(mergedAtHead)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(3)
    await expect(
      fetch('/repo', 'feature/inflight-head', {
        currentHeadOid: 'bbbbbbb'
      })
    ).resolves.toBeNull()
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(3)
  })

  it('does not preserve a merged GitHub review after the worktree moves off its head', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/merged',
      null,
      'repo-1',
      null,
      null,
      true
    )
    const store = makeStore()
    store.setState({
      hostedReviewCache: {
        [cacheKey]: {
          data: {
            provider: 'github',
            number: 7,
            title: 'Merged at head',
            state: 'merged',
            url: 'https://github.com/acme/orca/pull/7',
            status: 'success',
            updatedAt: '2026-05-10T00:00:00.000Z',
            mergeable: 'MERGEABLE',
            headSha: 'aaaaaaa'
          },
          fetchedAt: Date.now(),
          linkedReviewHintKey: ''
        }
      }
    })
    mockApi.hostedReview.forBranch.mockRejectedValueOnce(new Error('transient gh failure'))

    try {
      // Failure after head advance must not preserve the prior merged review.
      await expect(
        store.getState().fetchHostedReviewForBranch('/repo', 'feature/merged', {
          force: true,
          currentHeadOid: 'bbbbbbb'
        })
      ).resolves.toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })
})
