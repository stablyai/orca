import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createHostedReviewSlice } from './hosted-review'
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
        linkedGiteaPR: null
      },
      { timeoutMs: 30_000 }
    )
  })
})
