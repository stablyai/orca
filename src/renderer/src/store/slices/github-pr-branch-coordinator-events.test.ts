import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from './github'
import {
  createTestStore,
  installLinkedPRClearStub,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import type { AppState } from '../types'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'

describe('createGitHubSlice.fetchPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prForBranch.mockResolvedValue(null)
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.gh.refreshPRNow.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
  })

  it('clears a linked merged PR from a coordinator refresh event when the request head diverged', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/coordinator-diverged'
    const worktreeId = 'wt-coordinator-diverged'
    const cacheKey = `${repoId}::${branch}`
    const worktree = makePRRefreshWorktree({
      id: worktreeId,
      repoId,
      branch,
      head: 'current-head',
      linkedPR: 12
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree
    })

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey,
          repoPath,
          repoId,
          branch,
          worktreeId,
          linkedPRNumber: 12,
          currentHeadOid: 'current-head'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({
          number: 12,
          state: 'merged',
          headSha: 'merged-pr-head',
          headDivergedFromMergedPRAtOid: 'current-head'
        }),
        fetchedAt: 2
      }
    })

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
  })

  it('clears a branch-mismatched linked open PR from an accepted coordinator event', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/current'
    const worktreeId = 'wt-coordinator-open-mismatch'
    const cacheKey = `${repoId}::${branch}`
    const worktree = makePRRefreshWorktree({
      id: worktreeId,
      repoId,
      branch,
      head: 'current-head',
      linkedPR: 12
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree
    })

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey,
          repoPath,
          repoId,
          branch,
          worktreeId,
          linkedPRNumber: 12,
          currentHeadOid: 'current-head'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, state: 'open', headSha: 'old-head', headRefName: 'feature/old' }),
        fetchedAt: 2
      }
    })

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
  })

  it('does not scan worktrees for a found coordinator outcome without a durable PR link', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/unlinked'
    let worktreeIdReads = 0
    const worktrees = Array.from({ length: 100 }, (_, index) => {
      const worktree = makePRRefreshWorktree({
        id: `wt-${index}`,
        repoId,
        branch: `feature/${index}`,
        head: `head-${index}`,
        linkedPR: null
      })
      Object.defineProperty(worktree, 'id', {
        enumerable: true,
        get: () => {
          worktreeIdReads += 1
          return `wt-${index}`
        }
      })
      return worktree
    })
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: { [repoId]: worktrees }
    } as unknown as Partial<AppState>)
    worktreeIdReads = 0

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey: `${repoId}::${branch}`,
          repoPath,
          repoId,
          branch,
          worktreeId: 'wt-0',
          linkedPRNumber: null,
          currentHeadOid: 'head-0'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, state: 'open', headRefName: branch }),
        fetchedAt: 2
      }
    })

    expect(worktreeIdReads).toBe(0)
  })

  it('indexes worktrees once for a coordinator outcome with many linked aliases', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/shared'
    let worktreeIdReads = 0
    const worktrees = Array.from({ length: 100 }, (_, index) => {
      const worktree = makePRRefreshWorktree({
        id: `wt-${index}`,
        repoId,
        branch,
        head: 'shared-head',
        linkedPR: 12
      })
      Object.defineProperty(worktree, 'id', {
        enumerable: true,
        get: () => {
          worktreeIdReads += 1
          return `wt-${index}`
        }
      })
      return worktree
    })
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: { [repoId]: worktrees }
    } as unknown as Partial<AppState>)
    worktreeIdReads = 0

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: worktrees.map((_, index) => ({
        cacheKey: `${repoId}::${branch}::${index}`,
        repoPath,
        repoId,
        branch,
        worktreeId: `wt-${index}`,
        linkedPRNumber: 12,
        currentHeadOid: 'shared-head'
      })),
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, state: 'open', headSha: 'shared-head', headRefName: branch }),
        fetchedAt: 2
      }
    })

    // One read per stored row proves aliases share the event-local index.
    expect(worktreeIdReads).toBe(worktrees.length)
  })

  it('does not unlink from a branch-mismatched outcome rejected by the sequence gate', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/current'
    const worktreeId = 'wt-coordinator-stale-sequence'
    const cacheKey = `${repoId}::${branch}`
    const worktree = makePRRefreshWorktree({
      id: worktreeId,
      repoId,
      branch,
      head: 'current-head',
      linkedPR: 12
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree
    })
    const aliases = [
      {
        cacheKey,
        repoPath,
        repoId,
        branch,
        worktreeId,
        linkedPRNumber: 12,
        currentHeadOid: 'current-head'
      }
    ]

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 2,
      reason: 'swr',
      aliases,
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, state: 'open', headRefName: branch }),
        fetchedAt: 3
      }
    })
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases,
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, state: 'open', headSha: 'old-head', headRefName: 'feature/old' }),
        fetchedAt: 4
      }
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
    expect(store.getState().prRefreshSequences[cacheKey]).toBe(2)
  })

  it('does not unlink an ambiguous worktree id shared by multiple hosts', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/current'
    const worktreeId = 'repo-1::/same/path'
    const cacheKey = `${repoId}::${branch}`
    const updateWorktreeMeta = vi.fn()
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'local-head',
            linkedPR: 12,
            hostId: 'local'
          }),
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'ssh-head',
            linkedPR: 12,
            hostId: 'ssh:ssh-1'
          })
        ]
      },
      updateWorktreeMeta
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey,
          repoPath,
          repoId,
          branch,
          worktreeId,
          linkedPRNumber: 12,
          currentHeadOid: 'local-head'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, state: 'open', headSha: 'old-head', headRefName: 'feature/old' }),
        fetchedAt: 2
      }
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]).toHaveLength(2)
    expect(
      store.getState().worktreesByRepo[repoId]?.every((worktree) => worktree.linkedPR === 12)
    ).toBe(true)
  })

  it('does not let an old-host coordinator event unlink a row now owned by another host', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/current'
    const worktreeId = 'repo-1::/same/path'
    const cacheKey = `ssh:ssh-1::${repoId}::${branch}`
    const updateWorktreeMeta = vi.fn()
    store.setState({
      repos: [
        {
          id: repoId,
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-2'
        }
      ],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'ssh-2-head',
            linkedPR: 12,
            hostId: 'ssh:ssh-2'
          })
        ]
      },
      updateWorktreeMeta
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey,
          repoPath,
          repoId,
          branch,
          worktreeId,
          linkedPRNumber: 12,
          currentHeadOid: 'old-host-head',
          executionHostId: 'ssh:ssh-1'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, state: 'open', headSha: 'old-head', headRefName: 'feature/old' }),
        fetchedAt: 2
      }
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('does not clear a linked merged PR from a coordinator refresh event without a request head', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/coordinator-no-head'
    const worktreeId = 'wt-coordinator-no-head'
    const cacheKey = `${repoId}::${branch}`
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        { cacheKey, repoPath, repoId, branch, worktreeId, linkedPRNumber: 12, currentHeadOid: null }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({
          number: 12,
          state: 'merged',
          headSha: 'merged-pr-head',
          headDivergedFromMergedPRAtOid: 'current-head'
        }),
        fetchedAt: 2
      }
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('clears only the diverged worktree when a PR-number-coalesced event fans out to sibling aliases', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const worktreeA = makePRRefreshWorktree({
      id: 'wt-a',
      repoId,
      branch: 'feature/a',
      head: 'head-a',
      linkedPR: 12
    })
    const worktreeB = makePRRefreshWorktree({
      id: 'wt-b',
      repoId,
      branch: 'feature/b',
      head: 'head-b',
      linkedPR: 12
    })
    const updateWorktreeMeta = vi.fn(
      async (
        worktreeId: string,
        updates: Parameters<AppState['updateWorktreeMeta']>[1],
        options?: Parameters<AppState['updateWorktreeMeta']>[2]
      ) => {
        const current = store
          .getState()
          .worktreesByRepo[repoId]?.find((worktree) => worktree.id === worktreeId)
        if (options?.shouldApply && !options.shouldApply(current)) {
          return
        }
        store.setState((state) => ({
          worktreesByRepo: {
            ...state.worktreesByRepo,
            [repoId]: (state.worktreesByRepo[repoId] ?? []).map((worktree) =>
              worktree.id === worktreeId ? { ...worktree, ...updates } : worktree
            )
          }
        }))
      }
    )
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: { [repoId]: [worktreeA, worktreeB] },
      updateWorktreeMeta
    } as unknown as Partial<AppState>)

    // The coordinator coalesces linked PR refreshes by PR number, so one probe
    // (worktree A's head) is broadcast to both aliases. Only A actually diverged;
    // B is still on a contained commit and must keep its link.
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey: `${repoId}::feature/a`,
          repoPath,
          repoId,
          branch: 'feature/a',
          worktreeId: 'wt-a',
          linkedPRNumber: 12,
          currentHeadOid: 'head-a'
        },
        {
          cacheKey: `${repoId}::feature/b`,
          repoPath,
          repoId,
          branch: 'feature/b',
          worktreeId: 'wt-b',
          linkedPRNumber: 12,
          currentHeadOid: 'head-b'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({
          number: 12,
          state: 'merged',
          headSha: 'merged-pr-head',
          headDivergedFromMergedPRAtOid: 'head-a'
        }),
        fetchedAt: 2
      }
    })

    const worktrees = store.getState().worktreesByRepo[repoId] ?? []
    expect(worktrees.find((worktree) => worktree.id === 'wt-a')?.linkedPR).toBeNull()
    expect(worktrees.find((worktree) => worktree.id === 'wt-b')?.linkedPR).toBe(12)
  })

  it.each(['open', 'draft'] as const)(
    'clears visible cached %s PR data when a fallback refresh event misses',
    (state) => {
      const store = createTestStore()
      const repoPath = '/repo'
      const repoId = 'repo-1'
      const branch = 'feature/event-fallback-miss'
      const cacheKey = `${repoId}::${branch}`
      const cachedPR = makePR({ number: 12, state, title: 'Visible event PR' })
      const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

      store.setState({
        prCache: {
          [cacheKey]: {
            data: cachedPR,
            fetchedAt: 1
          }
        },
        hostedReviewCache: {
          [hostedReviewCacheKey]: {
            data: {
              provider: 'github',
              number: 12,
              title: 'Visible event PR',
              state,
              url: 'https://github.com/acme/orca/pull/12',
              status: 'pending',
              updatedAt: '2026-03-28T00:00:00Z',
              mergeable: 'UNKNOWN'
            },
            fetchedAt: 1,
            linkedReviewHintKey: 'github:12'
          }
        }
      } as unknown as Partial<AppState>)

      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [{ cacheKey, repoId, repoPath, branch, fallbackPRNumber: 12 }],
        reason: 'visible',
        outcome: { kind: 'no-pr', fetchedAt: 2 }
      })

      expect(store.getState().prCache[cacheKey]).toEqual({ data: null, fetchedAt: 2 })
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
        data: null,
        fetchedAt: 2,
        linkedReviewHintKey: 'github:12'
      })
    }
  )

  it('preserves cached merged PR data when a no-PR refresh event matches the worktree head', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-merged-pr-head-match'
    const cacheKey = `${repoId}::${branch}`
    const worktreeId = 'wt-merged-event-match'
    const cachedPR = makePR({
      number: 12,
      title: 'Merged event PR still checked out',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'merged-head'
          })
        ]
      },
      prCache: {
        [cacheKey]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch, worktreeId }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: cachedPR, fetchedAt: 1 })
    vi.advanceTimersByTime(1000)
    expect(mockApi.cache.setGitHub).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'worktree id is missing',
      worktreeId: undefined,
      linkedPRNumber: undefined,
      worktreesByRepo: {}
    },
    {
      name: 'worktree cannot be found',
      worktreeId: 'wt-missing-event',
      linkedPRNumber: undefined,
      worktreesByRepo: { 'repo-1': [] }
    },
    {
      name: 'worktree head is empty',
      worktreeId: 'wt-empty-event-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-empty-event-head',
            branch: 'feature/event-merged-pr-stale',
            head: ''
          })
        ]
      }
    },
    {
      name: 'cached PR head differs from worktree head',
      worktreeId: 'wt-moved-event-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-moved-event-head',
            branch: 'feature/event-merged-pr-stale',
            head: 'new-head'
          })
        ]
      }
    },
    {
      name: 'an explicit linked PR lookup misses',
      worktreeId: 'wt-linked-event-miss',
      linkedPRNumber: 12,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-linked-event-miss',
            branch: 'feature/event-merged-pr-stale',
            head: 'merged-head',
            linkedPR: 12
          })
        ]
      }
    }
  ])('clears cached merged PR data on no-PR refresh event when $name', (testCase) => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-merged-pr-stale'
    const cacheKey = `${repoId}::${branch}`
    const cachedPR = makePR({
      number: 12,
      title: 'Stale merged event PR',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      worktreesByRepo: testCase.worktreesByRepo,
      prCache: {
        [cacheKey]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [
        {
          cacheKey,
          repoId,
          repoPath,
          branch,
          worktreeId: testCase.worktreeId,
          linkedPRNumber: testCase.linkedPRNumber
        }
      ],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: null, fetchedAt: 2 })
  })
})
