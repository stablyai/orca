import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { createWorktreeIdentity } from '../../../../../shared/worktree/identity'
import { getGitHubPRCacheKey } from '../../../../../shared/github/github-cache-key'
import { forgeOwnerHostIdForWorkspace } from '../../../runtime/source-control/forge/forge-credential-target'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../requests/request-coordination'
import { createUpdateWorktreeMeta } from '../../slices/worktrees/metadata/update-worktree-meta'
import { findKnownWorktreeById } from '../../slices/worktrees/listing/detected-worktree-meta'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../github-slice-test-harness'

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
})
