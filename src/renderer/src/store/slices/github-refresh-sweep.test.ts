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

describe('createGitHubSlice.refreshAllGitHub', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('publishes no store update when the cache sweep changes nothing', () => {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'repo',
          badgeColor: '',
          addedAt: 1,
          kind: 'git'
        }
      ],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
      worktreesByRepo: { 'repo-1': [makePRRefreshWorktree()] }
    })
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    store.getState().refreshAllGitHub()
    unsubscribe()

    expect(publications).toBe(0)
  })

  it('still clears populated comments when no workspace refresh is needed', () => {
    const store = createTestStore()
    store.setState({
      commentsCache: { cached: { data: [], fetchedAt: 1 } },
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false
    })
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    store.getState().refreshAllGitHub()
    unsubscribe()

    expect(store.getState().commentsCache).toEqual({})
    expect(publications).toBe(1)
  })

  it('skips repo and worktree identity reads when no GitHub decoration is visible', () => {
    const store = createTestStore()
    const repoId = 'repo-idle'
    let repoIdentityReads = 0
    let worktreeRepoIdentityReads = 0
    const repo = { id: repoId, path: '/idle', name: 'idle', kind: 'git' as const }
    const worktree = makePRRefreshWorktree({
      id: 'wt-idle',
      repoId,
      path: '/idle/worktrees/idle',
      branch: 'feature/idle'
    })
    Object.defineProperty(repo, 'id', {
      configurable: true,
      enumerable: true,
      get: () => {
        repoIdentityReads += 1
        return repoId
      }
    })
    Object.defineProperty(worktree, 'repoId', {
      configurable: true,
      enumerable: true,
      get: () => {
        worktreeRepoIdentityReads += 1
        return repoId
      }
    })
    store.setState({
      repos: [repo],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
      commentsCache: { cached: { data: [], fetchedAt: 1 } },
      worktreesByRepo: { [repoId]: [worktree] }
    } as unknown as Partial<AppState>)
    repoIdentityReads = 0
    worktreeRepoIdentityReads = 0

    store.getState().refreshAllGitHub()

    expect(store.getState().commentsCache).toEqual({})
    expect(repoIdentityReads).toBe(0)
    expect(worktreeRepoIdentityReads).toBe(0)
    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
    expect(mockApi.gh.issue).not.toHaveBeenCalled()
  })

  it.each(['repo', 'pr-status'] as const)(
    'does not fan out PR lookups on resume with %s grouping',
    (groupBy) => {
      const store = createTestStore()
      store.setState({
        repos: [
          {
            id: 'repo-1',
            path: '/repo',
            displayName: 'repo',
            badgeColor: '',
            addedAt: 1,
            kind: 'git'
          }
        ],
        groupBy,
        worktreeCardProperties: ['pr', 'status'],
        rightSidebarOpen: true,
        rightSidebarTab: 'source-control',
        activeWorktreeId: 'visible',
        visibleReviewWorktreeIds: ['visible'],
        worktreesByRepo: {
          'repo-1': [
            makePRRefreshWorktree({ id: 'visible', branch: 'visible' }),
            ...Array.from({ length: 100 }, (_, index) =>
              makePRRefreshWorktree({
                id: `offscreen-${index}`,
                branch: `offscreen-${index}`
              })
            )
          ]
        }
      })
      store.getState().refreshAllGitHub()
      expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
      expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    }
  )

  it('keeps runtime issue dispatch repo identity reads linear', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-linear-issue',
      ok: true,
      result: null,
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoCount = 128
    let repoIdentityReads = 0
    const repos = Array.from({ length: repoCount }, (_, index) => {
      const repoId = `issue-repo-${index}`
      const repoPath = `/runtime/issues-${index}`
      const repo = {
        id: repoId,
        path: repoPath,
        name: repoId,
        kind: 'git' as const,
        executionHostId: 'runtime:env-1'
      }
      Object.defineProperty(repo, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          repoIdentityReads += 1
          return repoId
        }
      })
      return Object.defineProperty(repo, 'path', {
        configurable: true,
        enumerable: true,
        get: () => {
          repoIdentityReads += 1
          return repoPath
        }
      })
    })
    const worktreesByRepo = Object.fromEntries(
      repos.map((repo, index) => [
        repo.id,
        [
          makePRRefreshWorktree({
            id: `issue-wt-${index}`,
            repoId: repo.id,
            path: `${repo.path}/worktrees/feature`,
            linkedIssue: index + 1
          })
        ]
      ])
    )
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos,
      groupBy: 'repo',
      worktreeCardProperties: ['issue'],
      worktreesByRepo
    } as unknown as Partial<AppState>)
    repoIdentityReads = 0

    store.getState().refreshAllGitHub()

    await vi.waitFor(() => expect(Object.keys(store.getState().issueCache)).toHaveLength(repoCount))
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(repoCount)
    expect(repoIdentityReads).toBeLessThanOrEqual(repoCount * 15)
  })

  it('does not refresh stale linked issues when the issue card section is hidden', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            lastActivityAt: 1,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshAllGitHub()
    await Promise.resolve()

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
  })

  it('refreshes stale linked issues when the issue card section is visible', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['issue'],
      rightSidebarOpen: false,
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            lastActivityAt: 1,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshAllGitHub()
    await Promise.resolve()

    expect(mockApi.gh.issue).toHaveBeenCalledWith({
      repoPath,
      repoId: 'repo-1',
      number: 123
    })
  })
})

describe('createGitHubSlice.refreshGitHubForWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('refreshes runtime PR data directly after invalidating a worktree', async () => {
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
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktree(worktreeId)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: {
        repo: 'repo-1',
        branch,
        linkedPRNumber: null,
        currentHeadOid: null,
        reason: 'post-push'
      },
      timeoutMs: 30_000
    })
  })

  it('bounds rejected post-push PR refresh IPCs', async () => {
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
      }
    } as unknown as Partial<AppState>)

    try {
      store.getState().refreshGitHubForWorktree(worktreeId)

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith('Failed to enqueue PR refresh:', error)
      )
    } finally {
      warn.mockRestore()
    }
  })
})
