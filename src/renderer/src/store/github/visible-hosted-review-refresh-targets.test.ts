import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../../shared/repo-types'
import type { HostedReviewInfo } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import '../../../../shared/global-settings-test-fixture'
import { getHostedReviewCacheKey } from '../slices/hosted-review-cache-identity'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../slices/github-slice-test-harness'
import {
  getVisibleHostedReviewRefreshTargets,
  getVisibleHostedReviewWorkspaces,
  visibleHostedReviewRefreshInputsChanged
} from './visible-hosted-review-refresh-targets'
import '@/components/sidebar/workspace-card/review/workspace-reference-details'
import { createVisibleHostedReviewRefreshScheduler } from './visible-hosted-review-refresh-scheduler'
import '../slices/hosted-review-card-refresh'

const repo: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const worktree = makePRRefreshWorktree()
const review: HostedReviewInfo = {
  provider: 'gitlab',
  number: 8,
  title: 'Review',
  state: 'open',
  status: 'success',
  url: 'https://example.com/review/8',
  updatedAt: '',
  mergeable: 'MERGEABLE'
}
const hostedKey = getHostedReviewCacheKey(
  repo.path,
  worktree.branch,
  null,
  repo.id,
  null,
  null,
  true
)
const prKey = `${repo.id}::${worktree.branch}`

function setup(owner: Repo = repo) {
  const store = createTestStore()
  store.setState({
    repos: [owner],
    settings: null,
    worktreesByRepo: { [repo.id]: [worktree] },
    activeWorktreeId: null,
    visibleReviewWorktreeIds: [worktree.id],
    sshConnectionStates: new Map()
  })
  return store
}

function targets(store: ReturnType<typeof setup>) {
  return getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)
}

describe('visible hosted review refresh targets', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.hostedReview.forBranch.mockResolvedValue(review)
  })
  afterEach(() => vi.useRealTimers())

  it.each(['github', 'gitlab'] as const)(
    'refreshes both %s copies when direct SSH and runtime ownership share a physical host',
    async (provider) => {
      const direct: Repo = { ...repo, connectionId: 'builder' }
      const paired: Repo = { ...direct, executionHostId: 'runtime:owner-server' }
      const store = setup(direct)
      store.setState({
        repos: [paired, direct],
        worktreesByRepo: {
          [repo.id]: [
            {
              ...worktree,
              hostId: 'ssh:builder',
              runtimeOwnerEnvironmentId: 'owner-server',
              ...(provider === 'github' ? { linkedPR: 22 } : { linkedGitLabMR: 9 })
            },
            {
              ...worktree,
              hostId: 'ssh:builder',
              ...(provider === 'github' ? { linkedPR: 12 } : { linkedGitLabMR: 8 })
            }
          ]
        },
        sshConnectionStates: new Map([
          [
            'builder',
            { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }
          ]
        ])
      })
      mockApi.gh.refreshPRNow.mockResolvedValue({
        kind: 'found',
        pr: makePR({ number: 12 }),
        fetchedAt: Date.now()
      })
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'review',
        ok: true,
        result: provider === 'github' ? makePR({ number: 22 }) : { ...review, number: 9 }
      })

      const rows = targets(store)
      const directKey = `ssh:builder::${repo.id}::${worktree.branch}`
      const pairedKey = `runtime:owner-server::${repo.id}::${worktree.branch}`
      expect([...getVisibleHostedReviewWorkspaces(store.getState())]).toHaveLength(2)
      expect(rows.map((row) => row.key).sort()).toEqual(
        provider === 'github' ? [pairedKey] : [pairedKey, directKey].sort()
      )
      for (const row of rows) {
        expect(await row.refresh()).toBe(true)
      }
      if (provider === 'github') {
        await store.getState().fetchPRForBranch(repo.path, worktree.branch, {
          force: true,
          repoId: repo.id,
          repoOwnerExecutionHostId: 'ssh:builder',
          worktreeId: worktree.id,
          linkedPRNumber: 12
        })
      }
      expect(store.getState().hostedReviewCache[directKey]?.data?.number).toBe(
        provider === 'github' ? 12 : 8
      )
      expect(store.getState().hostedReviewCache[pairedKey]?.data?.number).toBe(
        provider === 'github' ? 22 : 9
      )
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'owner-server',
          method: provider === 'github' ? 'github.prForBranch' : 'hostedReview.forBranch'
        })
      )
      const directTransport =
        provider === 'github' ? mockApi.gh.refreshPRNow : mockApi.hostedReview.forBranch
      expect(directTransport).toHaveBeenCalledTimes(1)
    }
  )

  it('detects preserved hosted cache failures and backs off without blanking the review', async () => {
    const store = setup()
    store.setState({
      hostedReviewCache: { [hostedKey]: { data: review, fetchedAt: Date.now() - 120_000 } }
    })
    mockApi.hostedReview.forBranch.mockRejectedValue(new Error('temporary failure'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    const unsubscribe = store.subscribe((state, previous) => {
      if (visibleHostedReviewRefreshInputsChanged(state, previous)) {
        scheduler.update(targets(store))
      }
    })
    scheduler.update(targets(store))
    scheduler.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    expect(store.getState().hostedReviewCache[hostedKey].data).toEqual(review)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    scheduler.dispose()
    unsubscribe()
    log.mockRestore()
  })

  it('refreshes the selected runtime copy when repository and worktree IDs collide', async () => {
    const first: Repo = {
      ...repo,
      executionHostId: 'runtime:first',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/acme/orca',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/acme/orca.git'
      }
    }
    const second: Repo = { ...first, executionHostId: 'runtime:second' }
    const store = setup(first)
    store.setState({
      repos: [first, second],
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'runtime:second',
      worktreesByRepo: {
        first: [{ ...worktree, hostId: 'runtime:first' }],
        second: [{ ...worktree, hostId: 'runtime:second' }]
      }
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'pr-second',
      ok: true,
      result: makePR({ number: 26 }),
      _meta: { runtimeId: 'second' }
    })
    const selected = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, {
      selectedOnly: true
    })
    expect(selected).toHaveLength(1)
    expect(await selected[0].refresh()).toBe(true)
    expect(store.getState().prCache[`runtime:second::${prKey}`]?.data?.number).toBe(26)
    expect(store.getState().prCache[`runtime:first::${prKey}`]).toBeUndefined()
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'second' })
    )
  })
})
