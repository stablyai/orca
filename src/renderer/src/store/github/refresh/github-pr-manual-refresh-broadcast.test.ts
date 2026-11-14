import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../requests/request-coordination'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks
} from '../github-slice-test-harness'
import type { PRRefreshOutcome } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'

function createRefreshContext(pr: PRInfo | null = null) {
  const store = createTestStore()
  const repoPath = '/repo'
  const repoId = 'repo-1'
  const branch = 'feature/agent-made'
  const worktreeId = 'wt-agent-made'
  const cacheKey = `${repoId}::${branch}`
  const alias = { cacheKey, repoId, repoPath, branch, worktreeId }
  store.setState({
    repos: [
      { id: repoId, path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
    ],
    worktreesByRepo: {
      [repoId]: [makePRRefreshWorktree({ id: worktreeId, repoId, branch, head: 'head-oid' })]
    },
    prCache: { [cacheKey]: { data: pr, fetchedAt: 500 } }
  })
  return { store, repoPath, repoId, branch, worktreeId, cacheKey, alias }
}

describe('manual PR refresh whose outcome main also broadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.gh.prChecks.mockReset()
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
  })

  it('keeps a PR opened outside Orca in the PR cache after Refresh finds it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { store, repoPath, repoId, branch, worktreeId, cacheKey, alias } = createRefreshContext()
    const outcome: PRRefreshOutcome = { kind: 'found', pr: makePR({ number: 6 }), fetchedAt: 1_300 }
    // This ordering used to make the reply delete the PR that the broadcast had just found.
    mockApi.gh.refreshPRNow.mockImplementationOnce(async () => {
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [alias],
        reason: 'manual',
        requestStartedAt: 1_100,
        status: 'in-flight'
      })
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [alias],
        reason: 'manual',
        requestStartedAt: 1_100,
        outcome
      })
      return outcome
    })

    await store.getState().fetchPRForBranch(repoPath, branch, { force: true, repoId, worktreeId })

    expect(store.getState().prCache[cacheKey]).toMatchObject({
      data: expect.objectContaining({ number: 6 }),
      fetchedAt: 1_300
    })
  })
})
