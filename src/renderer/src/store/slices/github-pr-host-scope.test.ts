import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getGitHubPRCacheKey } from '../../../../shared/github/github-cache-key'
import { prChecksCacheSuffix, prCommentsCacheSuffix } from '../github/cache-identity'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import { getVisibleHostedReviewRefreshTargets } from '../github/visible-hosted-review-refresh-targets'
import { resolveChecksPanelReviewLookup } from '../../components/right-sidebar/checks-panel-review-lookup-authority'
import { createUpdateWorktreeMeta } from './worktrees/metadata/update-worktree-meta'
import { findKnownWorktreeById } from './worktrees/listing/detected-worktree-meta'
import { persistWorktreeMeta } from './worktrees/metadata/worktree-meta-persist'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

vi.mock('./worktrees/metadata/worktree-meta-persist', () => ({
  persistWorktreeMeta: vi.fn().mockResolvedValue(undefined)
}))

const localRepo: Repo = {
  id: 'project',
  path: '/local/project',
  displayName: 'Project',
  badgeColor: 'blue',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/owner/project',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/owner/project.git'
  }
}
const branch = 'feature/remote-ci'
const localPR = makePR({ number: 11, checksStatus: 'failure' })
const remotePR = makePR({ number: 22 })
const checks = [{ name: 'build', status: 'completed', conclusion: 'success', url: null }]

function setup(remoteRepo: Repo) {
  const store = createTestStore()
  const hostId = getRepoExecutionHostId(remoteRepo)
  const worktree = makePRRefreshWorktree({
    id: 'project::/worktree',
    repoId: remoteRepo.id,
    branch,
    hostId,
    linkedPR: remotePR.number
  })
  store.setState({
    repos: [localRepo, remoteRepo],
    worktreesByRepo: { project: [worktree] },
    activeWorktreeId: worktree.id,
    activeWorkspaceExecutionHostId: hostId,
    visibleReviewWorktreeIds: [worktree.id],
    sshConnectionStates: new Map([
      ['builder', { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }]
    ]),
    prCache: { [`project::${branch}`]: { data: localPR, fetchedAt: Date.now() } }
  })
  return { store, worktree, hostId }
}

describe('PR panel with local and remote copies of one project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.gh.refreshPRNow.mockResolvedValue({
      kind: 'found',
      pr: remotePR,
      fetchedAt: Date.now()
    })
    mockApi.gh.prChecks.mockResolvedValue(checks)
    mockApi.gh.prComments.mockResolvedValue([])
    runtimeEnvironmentCall.mockImplementation(({ method }) => ({
      id: method,
      ok: true,
      result:
        method === 'github.prForBranch' ? remotePR : method === 'github.prChecks' ? checks : [],
      _meta: { runtimeId: 'server' }
    }))
  })

  it.each([
    { host: 'ssh', samePath: false },
    { host: 'runtime', samePath: false },
    { host: 'ssh', samePath: true },
    { host: 'runtime', samePath: true }
  ])('loads PR details and CI for $host (same path: $samePath)', async ({ host, samePath }) => {
    const remoteRepo: Repo = {
      ...localRepo,
      path: samePath ? localRepo.path : '/remote/project',
      ...(host === 'ssh' ? { connectionId: 'builder' } : { executionHostId: 'runtime:server' })
    }
    const { store, worktree, hostId } = setup(remoteRepo)
    if (samePath) {
      store.setState({
        worktreesByRepo: {
          project: [
            { ...worktree, hostId: 'local', head: 'local-head', linkedPR: localPR.number },
            worktree
          ]
        }
      })
    }
    const options = {
      repoId: remoteRepo.id,
      worktreeId: worktree.id,
      linkedPRNumber: remotePR.number,
      ...(samePath ? { repoOwnerExecutionHostId: hostId } : {})
    }
    const key = getGitHubPRCacheKey(
      remoteRepo.path,
      remoteRepo.id,
      branch,
      null,
      remoteRepo.connectionId,
      remoteRepo.executionHostId,
      true
    )

    await store.getState().fetchPRForBranch(remoteRepo.path, branch, options)
    const pr = store.getState().prCache[key]?.data
    expect(pr?.number).toBe(remotePR.number)
    expect(
      resolveChecksPanelReviewLookup({
        pr,
        prCachedHasPR: pr != null,
        hostedReview: null
      }).state
    ).toBe('found')

    await store
      .getState()
      .fetchPRChecks(remoteRepo.path, remotePR.number, branch, undefined, null, options)
    await store.getState().fetchPRComments(remoteRepo.path, remotePR.number, options)

    expect(store.getState().prCache[key]?.data?.checksStatus).toBe('success')
    expect(
      store.getState().checksCache[`${hostId}::project::${prChecksCacheSuffix(remotePR.number)}`]
        ?.data
    ).toEqual(checks)
    expect(
      store.getState().commentsCache[
        `${hostId}::project::${prCommentsCacheSuffix(remotePR.number)}`
      ]?.data
    ).toEqual([])
    expect(store.getState().prCache[`project::${branch}`]?.data).toEqual(localPR)
  })

  it.each([false, true])(
    'refreshes the active server copy (colliding workspace ID: %s)',
    async (colliding) => {
      const remoteRepo: Repo = {
        ...localRepo,
        path: '/remote/project',
        executionHostId: 'runtime:server'
      }
      const { store, worktree } = setup(remoteRepo)
      if (colliding) {
        store.setState({
          worktreesByRepo: {
            project: [{ ...worktree, hostId: 'local', head: 'local-head', linkedPR: 11 }, worktree]
          }
        })
      }

      store.getState().enqueueGitHubPRRefresh(worktree.id, 'active', 80)

      await vi.waitFor(() => {
        expect(store.getState().prCache[`runtime:server::project::${branch}`]?.data?.number).toBe(
          22
        )
      })
      expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
      expect(store.getState().prCache[`project::${branch}`]?.data).toEqual(localPR)
    }
  )

  it.each(['ssh', 'runtime'] as const)(
    'clears only the %s copy of a linked merged PR on a fresh cache hit',
    async (host) => {
      const remoteRepo: Repo = {
        ...localRepo,
        ...(host === 'ssh' ? { connectionId: 'builder' } : { executionHostId: 'runtime:server' })
      }
      const { store, worktree, hostId } = setup(remoteRepo)
      const localWorktree = { ...worktree, hostId: 'local' as const }
      const cachedPR = makePR({
        number: remotePR.number,
        state: 'merged',
        headSha: 'merged-head',
        headDivergedFromMergedPRAtOid: worktree.head
      })
      const remoteKey = getGitHubPRCacheKey(
        remoteRepo.path,
        remoteRepo.id,
        branch,
        null,
        remoteRepo.connectionId,
        remoteRepo.executionHostId,
        true
      )
      const updateWorktreeMeta = vi.fn(createUpdateWorktreeMeta(store.setState, store.getState))
      store.setState({
        worktreesByRepo: { project: [localWorktree, worktree] },
        detectedWorktreesByRepo: {},
        folderWorkspaces: [],
        sortEpoch: 0,
        prCache: {
          ...store.getState().prCache,
          [remoteKey]: { data: cachedPR, fetchedAt: Date.now() }
        },
        getKnownWorktreeById: (id, ownerHostId) =>
          findKnownWorktreeById(store.getState(), id, ownerHostId),
        updateWorktreeMeta,
        fetchHostedReviewForBranch: vi.fn().mockResolvedValue(null)
      })

      expect(
        await store.getState().fetchPRForBranch(remoteRepo.path, branch, {
          repoId: remoteRepo.id,
          repoOwnerExecutionHostId: hostId,
          worktreeId: worktree.id,
          linkedPRNumber: remotePR.number
        })
      ).toEqual(cachedPR)
      await updateWorktreeMeta.mock.results[0]?.value

      expect(findKnownWorktreeById(store.getState(), worktree.id, 'local')).toBe(localWorktree)
      expect(findKnownWorktreeById(store.getState(), worktree.id, hostId)?.linkedPR).toBeNull()
      expect(persistWorktreeMeta).toHaveBeenCalledWith(
        host === 'runtime' ? { kind: 'environment', environmentId: 'server' } : { kind: 'local' },
        worktree.id,
        expect.objectContaining({ linkedPR: null }),
        hostId,
        undefined
      )
      expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    }
  )

  it.each(['ssh', 'runtime'])(
    'checks existing PR eligibility on the same %s owner',
    async (host) => {
      const remoteRepo: Repo = {
        ...localRepo,
        ...(host === 'ssh' ? { connectionId: 'builder' } : { executionHostId: 'runtime:server' })
      }
      const { store, hostId } = setup(remoteRepo)
      const eligibility = {
        provider: 'github',
        canCreate: false,
        blockedReason: 'existing_review',
        nextAction: 'open_existing_review',
        reviewLookupOutcome: 'found',
        review: { number: remotePR.number, url: remotePR.url }
      }
      mockApi.hostedReview.getCreationEligibility.mockResolvedValue(eligibility)
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'eligibility',
        ok: true,
        result: eligibility,
        _meta: { runtimeId: 'server' }
      })

      expect(
        await store.getState().getHostedReviewCreationEligibility({
          repoPath: remoteRepo.path,
          repoId: remoteRepo.id,
          repoOwnerExecutionHostId: hostId,
          branch
        })
      ).toEqual(eligibility)
      if (host === 'runtime') {
        expect(mockApi.hostedReview.getCreationEligibility).not.toHaveBeenCalled()
        expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
          expect.objectContaining({
            selector: 'server',
            params: { repo: remoteRepo.id, repoId: remoteRepo.id, branch }
          })
        )
      } else {
        expect(mockApi.hostedReview.getCreationEligibility).toHaveBeenCalledWith(
          expect.objectContaining({
            connectionId: 'builder',
            repoOwnerExecutionHostId: hostId
          })
        )
      }
    }
  )

  it('refuses a missing owner instead of loading the local copy', async () => {
    const { store } = setup({ ...localRepo, executionHostId: 'runtime:server' })
    await expect(
      store.getState().fetchPRForBranch(localRepo.path, branch, {
        repoId: localRepo.id,
        repoOwnerExecutionHostId: 'runtime:missing'
      })
    ).rejects.toThrow('owning host')
    await expect(
      store.getState().getHostedReviewCreationEligibility({
        repoPath: localRepo.path,
        repoId: localRepo.id,
        repoOwnerExecutionHostId: 'runtime:missing',
        branch
      })
    ).rejects.toThrow('owning host')
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(mockApi.hostedReview.getCreationEligibility).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('keeps automatic server refresh enabled when the local copy is listed first', async () => {
    const remoteRepo: Repo = {
      ...localRepo,
      path: '/remote/project',
      executionHostId: 'runtime:server'
    }
    const { store } = setup(remoteRepo)
    const key = getHostedReviewCacheKey(
      remoteRepo.path,
      branch,
      null,
      remoteRepo.id,
      null,
      remoteRepo.executionHostId,
      true
    )
    const targets = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)

    expect(targets.map((target) => target.key)).toContain(key)
    await targets.find((target) => target.key === key)?.refresh()
    expect(store.getState().prCache[`runtime:server::project::${branch}`]?.data?.number).toBe(22)
    expect(store.getState().prCache[`project::${branch}`]?.data).toEqual(localPR)
  })
})
