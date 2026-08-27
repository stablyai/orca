import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'

describe('createGitHubSlice.refreshGitHubForWorktreeIfStale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enqueues active PR refresh even when the cached PR is fresh', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      },
      worktreeCardProperties: ['status', 'pr'],
      prCache: {
        [`repo-1::${branch}`]: {
          data: makePR({ state: 'open' }),
          fetchedAt: Date.now()
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        cacheKey: `repo-1::${branch}`,
        cachedPRState: 'open',
        cachedMergeable: 'UNKNOWN'
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('does not direct-fetch when enqueue returns an automatic validation skip', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'
    mockApi.gh.enqueuePRRefresh.mockResolvedValueOnce({
      kind: 'skipped',
      skippedReason: 'validation-denied'
    })

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().enqueueGitHubPRRefresh(worktreeId, 'active', 80)
    await Promise.resolve()

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledTimes(1)
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
  })

  it('keeps a confirmed behind-head merged PR as the refresh fallback number', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-behind-head'
    const worktreeId = 'wt-merged-behind-fallback'
    mockApi.gh.enqueuePRRefresh.mockResolvedValueOnce({ kind: 'queued' })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'behind-head'
          })
        ]
      },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({
            number: 13,
            title: 'Merged PR with unpulled final head',
            state: 'merged',
            headSha: 'merged-final-head',
            confirmedContainedHeadOid: 'behind-head'
          }),
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().enqueueGitHubPRRefresh(worktreeId, 'active', 80)
    await Promise.resolve()

    // Why 13: a merged PR confirmed to contain this worktree head is still the
    // branch's PR; losing the fallback number would blank the panel whenever
    // GitHub stops reporting the deleted head by branch name.
    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          fallbackPRNumber: 13,
          // Why: main can only head-gate fallback preservation when the
          // candidate carries the worktree head it was built for.
          currentHeadOid: 'behind-head'
        })
      })
    )
  })

  it('direct-fetches when enqueue returns an explicit fallback result', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'
    mockApi.gh.enqueuePRRefresh.mockResolvedValueOnce({ kind: 'fallback' })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 1 })

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().enqueueGitHubPRRefresh(worktreeId, 'active', 80)
    await Promise.resolve()
    await Promise.resolve()

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledTimes(1)
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledTimes(1)
  })

  it('bounds rejected active PR refresh IPCs during worktree activation', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'
    const error = new Error('Access denied: unknown repository path')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.gh.enqueuePRRefresh.mockRejectedValueOnce(error)

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      },
      worktreeCardProperties: ['status', 'pr']
    } as unknown as Partial<AppState>)

    try {
      store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith('Failed to enqueue PR refresh:', error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('enqueues active PR refresh with a GitHub hosted-review fallback number', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/hosted-review-fallback'
    const worktreeId = 'wt-1'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      worktreeCardProperties: ['status', 'pr'],
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 44,
            title: 'Hosted review fallback PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/44',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: Date.now(),
          linkedReviewHintKey: 'github:44'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        fallbackPRNumber: 44
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('does not enqueue active PR refresh when no PR-related surface is visible', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
      rightSidebarTab: 'source-control',
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
  })

  it('does not fetch linked issue details when the issue card section is hidden', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)
    await Promise.resolve()

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
  })

  it('fetches linked issue details when the issue card section is visible', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['issue'],
      rightSidebarOpen: false,
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)
    await Promise.resolve()

    expect(mockApi.gh.issue).toHaveBeenCalledWith({
      repoPath,
      repoId: 'repo-1',
      number: 123
    })
  })

  it('enqueues active PR refresh IPC for connected SSH-backed repos', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-1'
        }
      ],
      groupBy: 'pr-status',
      sshConnectionStates: new Map([['ssh-1', { status: 'connected' }]]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        connectionId: 'ssh-1',
        connectionState: 'connected'
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('enqueues active PR refresh when source control is the visible PR surface', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      activeWorktreeId: worktreeId,
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({ repoPath, branch }),
      reason: 'active',
      priority: 80
    })
  })

  it('fetches PR through the runtime when activating a runtime workspace', async () => {
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 12 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/runtime'
    const worktreeId = 'wt-runtime'
    const hostedReviewCacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      {
        activeRuntimeEnvironmentId: 'env-1'
      } as AppState['settings'],
      'repo-1',
      null,
      'runtime:env-1',
      true
    )

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: 'repo-1',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ],
      groupBy: 'pr-status',
      worktreeCardProperties: ['status'],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/runtime',
            branch,
            displayName: 'runtime',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: 12
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-1', branch, linkedPRNumber: 12, currentHeadOid: null },
      timeoutMs: 30_000
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({
        provider: 'github',
        number: 12
      }),
      linkedReviewHintKey: 'github:12'
    })
    expect(store.getState().prCache[`runtime:env-1::repo-1::${branch}`]?.data).toMatchObject({
      number: 12
    })
    expect(store.getState().prCache[`repo-1::${branch}`]).toBeUndefined()
  })

  it('fetches PR through the owning runtime when local host is focused', async () => {
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 23, title: 'Owner runtime PR' }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/runtime/repo'
    const branch = 'feature/owner-runtime'

    store.setState({
      settings: null,
      repos: [
        {
          id: 'repo-runtime',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: null,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { repoId: 'repo-runtime' })
    ).resolves.toMatchObject({ number: 23 })

    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-runtime', branch, linkedPRNumber: null, currentHeadOid: null },
      timeoutMs: 30_000
    })
    expect(store.getState().prCache[`runtime:env-1::repo-runtime::${branch}`]?.data).toMatchObject({
      number: 23,
      title: 'Owner runtime PR'
    })
  })

  it('fetches SSH-owned PRs through local IPC when a runtime host is focused', async () => {
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ number: 34, title: 'SSH PR' }),
      fetchedAt: 10
    })
    const store = createTestStore()
    const repoPath = '/ssh/repo'
    const branch = 'feature/ssh-owner'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as AppState['settings'],
      repos: [
        {
          id: 'repo-ssh',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { repoId: 'repo-ssh' })
    ).resolves.toMatchObject({ number: 34 })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        cacheKey: `ssh:ssh-1::repo-ssh::${branch}`,
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1'
      })
    })
    expect(store.getState().prCache[`ssh:ssh-1::repo-ssh::${branch}`]?.data).toMatchObject({
      number: 34,
      title: 'SSH PR'
    })
    expect(store.getState().prCache[`runtime:env-focused::repo-ssh::${branch}`]).toBeUndefined()
  })

  it('uses the cached PR number as a fallback refresh hint when worktree metadata is not linked yet', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/cached-pr'
    const worktreeId = 'wt-cached-pr'

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'pr-status',
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/cached-pr',
            branch,
            displayName: 'cached-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({ number: 42 }),
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        linkedPRNumber: null,
        fallbackPRNumber: 42
      }),
      reason: 'active',
      priority: 80
    })
  })
})
