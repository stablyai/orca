/* eslint-disable max-lines -- Why: hosted-review tests cover runtime routing,
hinted cache revalidation, provider discovery, and PR cache reconciliation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createHostedReviewSlice, refreshHostedReviewCard } from './hosted-review'
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
    forBranch: vi.fn(),
    getCreationEligibility: vi.fn(),
    create: vi.fn()
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

describe('hosted review slice', () => {
  beforeEach(() => {
    mockApi.hostedReview.forBranch.mockReset()
    mockApi.hostedReview.getCreationEligibility.mockReset()
    mockApi.hostedReview.create.mockReset()
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

  it('uses SSH-scoped hosted review cache entries for SSH-backed repos', async () => {
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(review)
    const store = makeStore()
    store.setState({
      repos: [{ id: 'repo-1', path: '/repo', connectionId: 'ssh-1' } as AppState['repos'][number]]
    } as Partial<AppState>)

    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/gitlab', {
        repoId: 'repo-1'
      })
    ).resolves.toEqual(review)

    expect(store.getState().hostedReviewCache['ssh:ssh-1::repo-1::feature/gitlab']).toMatchObject({
      data: review
    })
    expect(store.getState().hostedReviewCache['local::repo-1::feature/gitlab']).toBeUndefined()
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

  it('forwards the selected worktree path when creating a local pull request', async () => {
    mockApi.hostedReview.create.mockResolvedValueOnce({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })
    const store = makeStore()

    await expect(
      store.getState().createHostedReview('/repo', {
        provider: 'github',
        base: 'main',
        head: 'feature/create-pr',
        title: 'Create PR',
        worktreePath: '/worktrees/feature'
      })
    ).resolves.toMatchObject({ ok: true, number: 12 })

    expect(mockApi.hostedReview.create).toHaveBeenCalledWith({
      repoPath: '/repo',
      connectionId: null,
      provider: 'github',
      base: 'main',
      head: 'feature/create-pr',
      title: 'Create PR',
      worktreePath: '/worktrees/feature'
    })
  })

  it('uses the selected worktree selector for runtime pull request creation', async () => {
    runtimeRpc.callRuntimeRpc.mockResolvedValueOnce({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })
    const store = makeStore({
      activeRuntimeEnvironmentId: 'env-win'
    } as AppState['settings'])

    await store.getState().createHostedReview('/repo', {
      provider: 'github',
      base: 'main',
      head: 'feature/create-pr',
      title: 'Create PR',
      worktreePath: 'C:\\worktrees\\feature'
    })

    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-win' },
      'hostedReview.create',
      {
        repo: 'repo-1',
        worktree: 'path:C:\\worktrees\\feature',
        provider: 'github',
        base: 'main',
        head: 'feature/create-pr',
        title: 'Create PR'
      },
      { timeoutMs: 60_000 }
    )
  })

  it('uses the selected worktree selector for runtime pull request creation eligibility', async () => {
    runtimeRpc.callRuntimeRpc.mockResolvedValueOnce({
      provider: 'github',
      review: null,
      canCreate: true,
      blockedReason: null,
      nextAction: null
    })
    const store = makeStore({
      activeRuntimeEnvironmentId: 'env-win'
    } as AppState['settings'])

    await store.getState().getHostedReviewCreationEligibility({
      repoPath: '/repo',
      worktreePath: 'C:\\worktrees\\feature',
      branch: 'feature/create-pr',
      base: 'main'
    })

    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-win' },
      'hostedReview.getCreationEligibility',
      {
        repo: 'repo-1',
        worktree: 'path:C:\\worktrees\\feature',
        branch: 'feature/create-pr',
        base: 'main'
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
})
