import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgeOwnerHostIdForWorkspace } from '../../runtime/forge-credential-target'
import type { PRComment } from '../../../../shared/github/comment-types'
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
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
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
  afterEach(() => vi.useRealTimers())

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

  it.each(['enqueue', 'refresh'] as const)(
    '%s preserves a server-qualified legacy SSH owner when direct SSH overlaps',
    async (action) => {
      const serverRepo: Repo = {
        ...localRepo,
        path: '/server/project',
        executionHostId: 'runtime:server',
        connectionId: 'builder'
      }
      const directRepo: Repo = {
        ...serverRepo,
        path: '/direct/project',
        executionHostId: 'ssh:builder'
      }
      const { store, worktree } = setup(serverRepo)
      const directKey = `ssh:builder::project::${branch}`
      const directEntry = { data: localPR, fetchedAt: Date.now() }
      store.setState({
        repos: [directRepo, serverRepo],
        worktreesByRepo: { project: [{ ...worktree, hostId: 'ssh:builder' }] },
        activeWorkspaceExecutionHostId: 'ssh:builder',
        prCache: { [directKey]: directEntry }
      })

      const refresh = () => {
        if (action === 'enqueue') {
          store.getState().enqueueGitHubPRRefresh(worktree.id, 'active', 80, 'runtime:server')
        } else {
          store.getState().refreshGitHubForWorktree(worktree.id, 'runtime:server')
        }
      }
      refresh()

      await vi.waitFor(() => {
        expect(store.getState().prCache[`runtime:server::project::${branch}`]?.data?.number).toBe(
          22
        )
      })
      expect(store.getState().prCache[directKey]).toBe(directEntry)
      expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
      expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ selector: 'server', method: 'github.prForBranch' })
      )

      vi.clearAllMocks()
      store.setState({ repos: [directRepo] })
      refresh()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
      expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
      expect(store.getState().prCache[directKey]).toBe(directEntry)
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

  it.each(['ssh', 'runtime', 'paired-legacy', 'paired-stamped'] as const)(
    'mutates the %s owner comment cache and preserves the same-ID twin',
    async (host) => {
      const remoteRepo: Repo = {
        ...localRepo,
        ...(host === 'ssh' ? { connectionId: 'builder' } : { executionHostId: 'runtime:server' })
      }
      if (host.startsWith('paired')) {
        remoteRepo.connectionId = 'builder'
      }
      const { store, hostId, worktree } = setup(remoteRepo)
      const workspace = host.startsWith('paired')
        ? {
            ...worktree,
            hostId: 'ssh:builder' as const,
            ...(host === 'paired-stamped' ? { runtimeOwnerEnvironmentId: 'server' } : {})
          }
        : worktree
      store.setState({ worktreesByRepo: { project: [workspace] } })
      const comment: PRComment = {
        id: 1,
        author: 'reviewer',
        authorAvatarUrl: '',
        body: 'Review',
        createdAt: '',
        url: '',
        threadId: 'thread',
        isResolved: false,
        reactionSubjectId: 'subject'
      }
      const reply = { ...comment, id: 2, body: 'Reply' }
      const conversation = { ...comment, id: 3, body: 'Conversation' }
      const options = {
        repoId: remoteRepo.id,
        repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(remoteRepo, workspace)
      }
      const suffix = prCommentsCacheSuffix(remotePR.number)
      const localKey = `project::${suffix}`
      const remoteKey = `${hostId}::project::${suffix}`
      const localEntry = { data: [comment], fetchedAt: Date.now() }
      store.setState({ commentsCache: { [localKey]: localEntry } })
      mockApi.gh.prComments.mockResolvedValue([comment])
      mockApi.gh.resolveReviewThread.mockResolvedValue(true)
      mockApi.gh.setPRCommentReaction.mockResolvedValue(false)
      mockApi.gh.addPRReviewCommentReply.mockResolvedValue({ ok: true, comment: reply })
      mockApi.gh.addIssueComment.mockResolvedValue({ ok: true, comment: conversation })
      runtimeEnvironmentCall.mockImplementation(({ method }) => ({
        id: method,
        ok: true,
        result:
          method === 'github.prComments'
            ? [comment]
            : method === 'github.resolveReviewThread'
              ? true
              : method === 'github.setPRCommentReaction'
                ? false
                : {
                    ok: true,
                    comment: method === 'github.addPRReviewCommentReply' ? reply : conversation
                  }
      }))

      await store.getState().fetchPRComments(remoteRepo.path, remotePR.number, options)
      const resolving = store
        .getState()
        .resolveReviewThread(remoteRepo.path, remotePR.number, 'thread', true, options)
      expect(store.getState().commentsCache[remoteKey]?.data?.[0].isResolved).toBe(true)
      expect(await resolving).toBe(true)
      const reacting = store
        .getState()
        .setPRCommentReaction(remoteRepo.path, remotePR.number, 'subject', '+1', true, options)
      expect(store.getState().commentsCache[remoteKey]?.data?.[0].reactions).toEqual([
        { content: '+1', count: 1, viewerHasReacted: true }
      ])
      expect(await reacting).toBe(false)
      expect(store.getState().commentsCache[remoteKey]?.data?.[0].reactions ?? []).toEqual([])
      await store
        .getState()
        .addPRReviewCommentReply(remoteRepo.path, remotePR.number, comment.id, reply.body, options)
      await store
        .getState()
        .addPRConversationComment(remoteRepo.path, remotePR.number, conversation.body, options)
      expect(store.getState().commentsCache[remoteKey]?.data?.map((entry) => entry.id)).toEqual([
        1, 2, 3
      ])
      expect(store.getState().commentsCache[localKey]).toBe(localEntry)
      if (host !== 'ssh') {
        expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
        expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
        expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
          expect.objectContaining({
            selector: 'server',
            method: 'github.resolveReviewThread'
          })
        )
      } else {
        expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledWith(
          expect.objectContaining({
            repoOwnerExecutionHostId: hostId
          })
        )
        expect(mockApi.gh.addIssueComment).toHaveBeenCalledWith(
          expect.objectContaining({
            repoOwnerExecutionHostId: hostId
          })
        )
      }
    }
  )

  it('keeps a manual linked-PR result for a paired SSH row that predates owner stamps', async () => {
    const pairedRepo: Repo = {
      ...localRepo,
      path: '/remote/project',
      connectionId: 'builder',
      executionHostId: 'runtime:server'
    }
    const { store, worktree } = setup(pairedRepo)
    store.setState({
      worktreesByRepo: { project: [{ ...worktree, hostId: 'ssh:builder' }] },
      activeWorkspaceExecutionHostId: 'ssh:builder'
    })

    const pr = await store.getState().fetchPRForBranch(pairedRepo.path, branch, {
      force: true,
      repoId: pairedRepo.id,
      repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(pairedRepo, {
        ...worktree,
        hostId: 'ssh:builder'
      }),
      worktreeId: worktree.id,
      linkedPRNumber: remotePR.number,
      reason: 'manual'
    })

    expect(pr?.number).toBe(remotePR.number)
    expect(store.getState().prCache[`runtime:server::project::${branch}`]?.data?.number).toBe(
      remotePR.number
    )
    expect(store.getState().prCache[`project::${branch}`]?.data).toEqual(localPR)
  })

  it('skips passive refreshes when a host-only API cannot distinguish nested SSH repository twins', () => {
    const pairedRepo: Repo = {
      ...localRepo,
      executionHostId: 'runtime:server',
      connectionId: 'builder'
    }
    const { store, worktree } = setup(pairedRepo)
    store.setState({
      repos: [pairedRepo, { ...pairedRepo, connectionId: 'other' }],
      worktreesByRepo: {
        project: [{ ...worktree, hostId: 'ssh:builder', runtimeOwnerEnvironmentId: 'server' }]
      }
    })
    expect(getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)).toEqual([])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('returns normal mutation failures when the selected repository owner is gone', async () => {
    const { store } = setup({ ...localRepo, executionHostId: 'runtime:server' })
    const options = { repoId: localRepo.id, repoOwnerExecutionHostId: 'runtime:missing' }
    await expect(
      store.getState().addPRConversationComment(localRepo.path, 22, 'comment', options)
    ).resolves.toMatchObject({ ok: false })
    await expect(
      store.getState().addPRReviewCommentReply(localRepo.path, 22, 1, 'reply', options)
    ).resolves.toMatchObject({ ok: false })
    await expect(
      store.getState().setPRCommentReaction(localRepo.path, 22, 'subject', '+1', true, options)
    ).resolves.toBe(false)
    await expect(
      store.getState().resolveReviewThread(localRepo.path, 22, 'thread', true, options)
    ).resolves.toBe(false)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
  })

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
