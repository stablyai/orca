import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import { getGitHubPRCacheKey } from '../../../../shared/github/github-cache-key'
import { forgeOwnerHostIdForWorkspace } from '../../runtime/forge-credential-target'
import {
  _clearGitHubPRRefreshStartedEntriesForTest,
  prRefreshStartedLinkedReviewScopes
} from '../github/request-coordination'
import { bumpHostedReviewLinkMutationGeneration } from './worktrees/metadata/hosted-review-link-mutation'
import { createUpdateWorktreeMeta } from './worktrees/metadata/update-worktree-meta'
import { findKnownWorktreeById } from './worktrees/listing/detected-worktree-meta'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

const repository: Repo = {
  id: 'project',
  path: '/project',
  displayName: 'Project',
  badgeColor: 'blue',
  addedAt: 1,
  executionHostId: 'runtime:server',
  connectionId: 'builder'
}
const branch = 'feature/review'
// Why: the cache route relies on isFresh(), so the frozen clock keeps that entry fresh deterministically.
const NOW = Date.UTC(2026, 0, 1)

function setup(stamped: boolean, durableIdentity = true) {
  const store = createTestStore()
  const workspace = makePRRefreshWorktree({
    id: 'project::/project/worktree',
    repoId: 'project',
    path: '/project/worktree',
    branch,
    hostId: 'ssh:builder',
    ...(stamped ? { runtimeOwnerEnvironmentId: 'server' } : {}),
    identity: durableIdentity
      ? createWorktreeIdentity({
          worktreeId: 'project::/project/worktree',
          executionHostId: 'ssh:builder',
          instanceId: 'original'
        })
      : undefined,
    linkedPR: 12,
    head: 'current-head'
  })
  const sibling = {
    ...workspace,
    hostId: 'local' as const,
    runtimeOwnerEnvironmentId: undefined,
    identity: durableIdentity
      ? createWorktreeIdentity({
          worktreeId: workspace.id,
          executionHostId: 'local',
          instanceId: 'sibling'
        })
      : undefined
  }
  const localRepo = { ...repository, connectionId: null, executionHostId: 'local' as const }
  const update = vi.fn(createUpdateWorktreeMeta(store.setState, store.getState))
  store.setState({
    repos: [localRepo, repository],
    worktreesByRepo: { project: [workspace, sibling] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    sortEpoch: 0,
    settings: null,
    activeWorkspaceExecutionHostId: 'local',
    getKnownWorktreeById: (id, host) => findKnownWorktreeById(store.getState(), id, host),
    updateWorktreeMeta: update,
    fetchHostedReviewForBranch: vi.fn().mockResolvedValue(null)
  })
  const key = getGitHubPRCacheKey(
    repository.path,
    repository.id,
    branch,
    null,
    repository.connectionId,
    repository.executionHostId,
    true
  )
  const alias = {
    cacheKey: key,
    repoId: repository.id,
    repoPath: repository.path,
    branch,
    executionHostId: repository.executionHostId,
    connectionId: repository.connectionId,
    worktreeId: workspace.id,
    linkedPRNumber: 12,
    currentHeadOid: workspace.head
  }
  const options = {
    repoId: repository.id,
    repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repository, workspace),
    worktreeId: workspace.id,
    linkedPRNumber: 12
  }
  return { store, workspace, sibling, update, key, alias, options }
}
const diverged = makePR({
  number: 12,
  state: 'merged',
  headSha: 'merged-head',
  headDivergedFromMergedPRAtOid: 'current-head'
})

describe('linked review clearing retains workspace and credential identities', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
    _clearGitHubPRRefreshStartedEntriesForTest()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockImplementation(({ method }) => ({
      id: method,
      ok: true,
      result: method === 'github.prForBranch' ? diverged : {},
      _meta: { runtimeId: 'server' }
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([100, 1000])(
    'bounds accepted refresh-start repository reads with %s repositories and overlapping SSH routes',
    (population) => {
      const { store, workspace, alias } = setup(false)
      let reads = 0
      const repos = Array.from({ length: population - 2 }, (_, index) => ({
        ...repository,
        get id() {
          reads++
          return `unrelated-${index}`
        }
      }))
      const direct: Repo = { ...repository, executionHostId: 'ssh:builder' }
      const directAlias = {
        ...alias,
        cacheKey: `ssh:builder::${repository.id}::${branch}`,
        executionHostId: direct.executionHostId
      }
      store.setState({
        repos: [...repos, repository, direct],
        worktreesByRepo: { project: [workspace] }
      })
      const start = (sequence: number) =>
        store.getState().applyGitHubPRRefreshEvent({
          sequence,
          reason: 'swr',
          aliases: [directAlias],
          status: 'in-flight',
          requestStartedAt: NOW
        })
      start(1)
      reads = 0
      for (let sequence = 2; sequence <= 101; sequence++) {
        start(sequence)
      }
      expect(store.getState().prRefreshSequences[directAlias.cacheKey]).toBe(101)
      expect(prRefreshStartedLinkedReviewScopes.get(directAlias.cacheKey)?.scope.workspace).toBe(
        workspace
      )
      expect(reads).toBe(0)
    }
  )

  it.each([100, 1000])(
    'bounds linked SSH request-start reads across %s workspaces',
    async (population) => {
      const { store, workspace, sibling, update, alias } = setup(true)
      let reads = 0
      const rows = Array.from({ length: population }, (_, index) => {
        const id = index === 0 ? workspace.id : `project::/unrelated-${index}`
        return {
          ...workspace,
          get id() {
            reads++
            return id
          }
        }
      })
      store.setState({ worktreesByRepo: { project: [...rows, sibling] } })
      const start = (sequence: number) =>
        store.getState().applyGitHubPRRefreshEvent({
          sequence,
          reason: 'swr',
          aliases: [alias],
          status: 'in-flight',
          requestStartedAt: NOW
        })
      start(1)
      expect(reads).toBeGreaterThanOrEqual(population)
      expect(reads).toBeLessThanOrEqual(3 * population + 10)
      reads = 0
      for (let sequence = 2; sequence <= population + 1; sequence++) {
        start(sequence)
      }
      expect(reads).toBeLessThanOrEqual(2 * population)
      store.getState().applyGitHubPRRefreshEvent({
        sequence: population + 1,
        reason: 'swr',
        aliases: [alias],
        outcome: { kind: 'found', pr: diverged, fetchedAt: NOW }
      })
      await update.mock.results[0]?.value
      expect(update).toHaveBeenCalledTimes(1)
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'server',
          method: 'worktree.set',
          params: expect.objectContaining({ linkedPR: null })
        })
      )
      expect(
        findKnownWorktreeById(store.getState(), workspace.id, 'ssh:builder')?.linkedPR
      ).toBeNull()
      expect(findKnownWorktreeById(store.getState(), workspace.id, 'local')).toBe(sibling)
    }
  )

  for (const stamped of [false, true]) {
    it.each(['cache', 'lookup', 'coordinator'] as const)(
      `persists the paired copy through %s (stamp: ${stamped})`,
      async (route) => {
        const { store, workspace, sibling, update, key, alias, options } = setup(stamped)
        if (route === 'cache') {
          store.setState({ prCache: { [key]: { data: diverged, fetchedAt: NOW } } })
        }
        if (route === 'coordinator') {
          store.getState().applyGitHubPRRefreshEvent({
            sequence: 71,
            reason: 'swr',
            aliases: [alias],
            status: 'in-flight',
            requestStartedAt: NOW
          })
          store.getState().applyGitHubPRRefreshEvent({
            sequence: 71,
            reason: 'swr',
            aliases: [alias],
            outcome: { kind: 'found', pr: diverged, fetchedAt: NOW }
          })
        } else {
          await store.getState().fetchPRForBranch(repository.path, branch, options)
        }
        await update.mock.results[0]?.value
        expect(update).toHaveBeenCalledTimes(1)
        expect(
          findKnownWorktreeById(store.getState(), workspace.id, 'ssh:builder')?.linkedPR
        ).toBeNull()
        expect(findKnownWorktreeById(store.getState(), workspace.id, 'local')).toBe(sibling)
        expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
          expect.objectContaining({
            selector: 'server',
            method: 'worktree.set',
            params: expect.objectContaining({
              worktree: `identity:${workspace.identity?.key}`,
              linkedPR: null
            })
          })
        )
      }
    )
  }

  it.each(['lookup', 'coordinator'] as const)(
    'persists a branch-mismatch clear through %s',
    async (route) => {
      const { store, workspace, sibling, update, alias, options } = setup(true)
      const mismatch = makePR({
        number: 12,
        state: 'open',
        headSha: 'old-head',
        headRefName: 'feature/old'
      })
      runtimeEnvironmentCall.mockImplementation(({ method }) => ({
        id: method,
        ok: true,
        result: method === 'github.prForBranch' ? mismatch : {},
        _meta: { runtimeId: 'server' }
      }))
      if (route === 'lookup') {
        await store.getState().fetchPRForBranch(repository.path, branch, options)
      } else {
        store.getState().applyGitHubPRRefreshEvent({
          sequence: 74,
          reason: 'swr',
          aliases: [alias],
          status: 'in-flight',
          requestStartedAt: NOW
        })
        store.getState().applyGitHubPRRefreshEvent({
          sequence: 74,
          reason: 'swr',
          aliases: [alias],
          outcome: { kind: 'found', pr: mismatch, fetchedAt: NOW }
        })
      }
      await update.mock.results[0]?.value
      expect(
        findKnownWorktreeById(store.getState(), workspace.id, 'ssh:builder')?.linkedPR
      ).toBeNull()
      expect(findKnownWorktreeById(store.getState(), workspace.id, 'local')).toBe(sibling)
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'server',
          method: 'worktree.set',
          params: expect.objectContaining({
            worktree: `identity:${workspace.identity?.key}`,
            linkedPR: null
          })
        })
      )
    }
  )

  it.each(['removed', 'ambiguous'] as const)(
    'handles a branch refetch whose owner becomes %s during unlinking',
    async (ownerState) => {
      const { store, update, options } = setup(true)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const mismatch = makePR({
        number: 12,
        state: 'open',
        headSha: 'old-head',
        headRefName: 'feature/old'
      })
      runtimeEnvironmentCall.mockImplementation(({ method }) => ({
        id: method,
        ok: true,
        result: mismatch,
        _meta: { runtimeId: 'server' }
      }))
      update.mockImplementationOnce(async () => {
        store.setState({
          repos: ownerState === 'removed' ? [] : [repository, { ...repository }]
        })
        return { ok: true }
      })

      await expect(
        store.getState().fetchPRForBranch(repository.path, branch, options)
      ).resolves.toEqual(mismatch)

      expect(update).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledWith(
        'Branch-scoped PR refetch skipped:',
        new Error('The repository is no longer available on its owning host. Reconnect and retry.')
      )
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { route: 'lookup', durable: true },
    { route: 'coordinator', durable: true },
    { route: 'lookup', durable: false },
    { route: 'coordinator', durable: false }
  ] as const)(
    'does not clear a replacement with identical branch, head and PR through $route (durable identity: $durable)',
    async ({ route, durable }) => {
      const { store, workspace, sibling, update, alias, options } = setup(true, durable)
      const replacement = {
        ...workspace,
        identity: durable
          ? createWorktreeIdentity({
              worktreeId: workspace.id,
              executionHostId: 'ssh:builder',
              instanceId: 'replacement'
            })
          : undefined
      }
      let finish: (response: unknown) => void = () => {}
      runtimeEnvironmentCall.mockImplementation(({ method }) =>
        method === 'github.prForBranch'
          ? new Promise((resolve) => {
              finish = resolve
            })
          : { id: method, ok: true, result: {}, _meta: { runtimeId: 'server' } }
      )
      const request =
        route === 'lookup'
          ? store.getState().fetchPRForBranch(repository.path, branch, options)
          : undefined
      if (route === 'lookup') {
        await vi.waitFor(() =>
          expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'github.prForBranch' })
          )
        )
      } else {
        store.getState().applyGitHubPRRefreshEvent({
          sequence: 72,
          reason: 'swr',
          aliases: [alias],
          status: 'in-flight',
          requestStartedAt: NOW
        })
      }
      store.setState({ worktreesByRepo: { project: [replacement, sibling] } })
      if (route === 'lookup') {
        finish({ id: 'done', ok: true, result: diverged, _meta: { runtimeId: 'server' } })
        await request
      } else {
        store.getState().applyGitHubPRRefreshEvent({
          sequence: 72,
          reason: 'swr',
          aliases: [alias],
          outcome: { kind: 'found', pr: diverged, fetchedAt: NOW }
        })
      }
      await update.mock.results[0]?.value
      expect(findKnownWorktreeById(store.getState(), workspace.id, 'ssh:builder')).toBe(replacement)
      expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'worktree.set' })
      )
    }
  )

  it('does not clear a manually relinked review whose final branch, head and link are unchanged', async () => {
    const { store, workspace, update, alias } = setup(true)
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 75,
      reason: 'swr',
      aliases: [alias],
      status: 'in-flight',
      requestStartedAt: NOW
    })
    bumpHostedReviewLinkMutationGeneration(workspace.id, workspace)
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 75,
      reason: 'swr',
      aliases: [alias],
      outcome: { kind: 'found', pr: diverged, fetchedAt: NOW }
    })
    await update.mock.results[0]?.value
    expect(findKnownWorktreeById(store.getState(), workspace.id, 'ssh:builder')).toBe(workspace)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worktree.set' })
    )
  })

  it('does not dispatch a host-only refetch after a valid metadata save with nested repository twins', async () => {
    const { store, workspace } = setup(true)
    store.setState({ repos: [repository, { ...repository, connectionId: 'other' }] })
    await expect(
      store
        .getState()
        .updateWorktreeMeta(workspace.id, { linkedPR: null }, { executionHostId: 'ssh:builder' })
    ).resolves.toEqual({ ok: true })
    expect(store.getState().fetchHostedReviewForBranch).not.toHaveBeenCalled()
  })

  it('preserves a push target updated while a branch-mismatch lookup was pending', async () => {
    const { store, workspace, sibling, update, alias } = setup(true)
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 76,
      reason: 'swr',
      aliases: [alias],
      status: 'in-flight',
      requestStartedAt: NOW
    })
    const current = {
      ...workspace,
      pushTarget: { remoteName: 'origin', branchName: 'feature/old' }
    }
    store.setState({ worktreesByRepo: { project: [current, sibling] } })
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 76,
      reason: 'swr',
      aliases: [alias],
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, headSha: 'old-head', headRefName: 'feature/old' }),
        fetchedAt: NOW
      }
    })
    await update.mock.results[0]?.value
    expect(findKnownWorktreeById(store.getState(), workspace.id, 'ssh:builder')).toBe(current)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worktree.set' })
    )
  })

  it('skips a coordinator clear without request-start evidence', () => {
    const { store, update, alias } = setup(true)
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 73,
      reason: 'swr',
      aliases: [alias],
      outcome: { kind: 'found', pr: diverged, fetchedAt: NOW }
    })
    expect(update).not.toHaveBeenCalled()
  })
})
