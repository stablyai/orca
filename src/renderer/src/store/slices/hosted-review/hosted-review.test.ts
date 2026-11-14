import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import { createHostedReviewSlice } from './hosted-review'

import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'

const runtimeRpc = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: runtimeRpc.callRuntimeRpc
}))

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

    await expect(
      fetch('/repo', 'feature/inflight-head', {
        currentHeadOid: 'bbbbbbb'
      })
    ).resolves.toBeNull()
  })
})
