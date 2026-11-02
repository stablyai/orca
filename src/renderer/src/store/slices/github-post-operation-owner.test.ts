import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { createGitRemotePushPull } from './editor/actions/git-remote-push-pull'
import { createGitRemoteSync } from './editor/actions/git-remote-sync'
import {
  fetchRuntimeGit,
  pullRuntimeGit,
  pushRuntimeGit,
  fastForwardRuntimeGit,
  rebaseRuntimeGitFromBase
} from '../../runtime/runtime-git-sync-client'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

vi.mock('../../runtime/runtime-git-sync-client', () => ({
  fetchRuntimeGit: vi.fn(),
  pullRuntimeGit: vi.fn(),
  pushRuntimeGit: vi.fn(),
  fastForwardRuntimeGit: vi.fn(),
  rebaseRuntimeGitFromBase: vi.fn(),
  getRuntimeGitUpstreamStatus: vi.fn().mockResolvedValue({
    hasUpstream: true,
    ahead: 1,
    behind: 0
  })
}))

const repo: Repo = {
  id: 'project',
  path: '/project',
  displayName: 'Project',
  badgeColor: 'blue',
  addedAt: 1
}
const branch = 'feature/review'
const operations = ['push', 'pull', 'fast-forward', 'sync', 'rebase'] as const

describe('post-operation review refresh ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.enqueuePRRefresh.mockResolvedValue(false)
    mockApi.gh.refreshPRNow.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 22 }),
      fetchedAt: Date.now()
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'review',
      ok: true,
      result: makePR({ number: 22 })
    })
  })
  afterEach(() => vi.useRealTimers())

  it.each(['ssh:builder', 'runtime:server'] as const)(
    'refreshes %s after pushing with a same-ID copy on the same physical SSH host',
    async (hostId) => {
      const store = createTestStore()
      const direct: Repo = { ...repo, connectionId: 'builder' }
      const paired: Repo = { ...direct, executionHostId: 'runtime:server' }
      const directKey = `ssh:builder::${repo.id}::${branch}`
      const pairedKey = `runtime:server::${repo.id}::${branch}`
      const ownerKey = hostId === 'ssh:builder' ? directKey : pairedKey
      const twinKey = hostId === 'ssh:builder' ? pairedKey : directKey
      const worktree = makePRRefreshWorktree({
        repoId: repo.id,
        branch,
        hostId: 'ssh:builder',
        linkedPR: 22
      })
      const twinEntry = { data: makePR({ number: 11 }), fetchedAt: Date.now() }
      store.setState({
        ...createGitRemotePushPull(store.setState, store.getState),
        beginRemoteOperation: vi.fn(() => vi.fn()),
        fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
        repos: [direct, paired],
        worktreesByRepo: {
          [repo.id]: [
            { ...worktree, linkedPR: hostId === 'ssh:builder' ? 22 : 11 },
            {
              ...worktree,
              runtimeOwnerEnvironmentId: 'server',
              linkedPR: hostId === 'runtime:server' ? 22 : 11
            }
          ]
        },
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: hostId,
        sshConnectionStates: new Map([
          [
            'builder',
            { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }
          ]
        ]),
        prCache: { [twinKey]: twinEntry }
      })
      const pending = Promise.withResolvers<void>()
      vi.mocked(pushRuntimeGit).mockReturnValueOnce(pending.promise)
      const runtimeTarget: RuntimeClientTarget =
        hostId === 'ssh:builder'
          ? { kind: 'local' }
          : { kind: 'environment', environmentId: 'server' }
      const task = store
        .getState()
        .pushBranch(worktree.id, worktree.path, false, 'builder', undefined, { runtimeTarget })
      store.setState({
        activeWorkspaceExecutionHostId: hostId === 'ssh:builder' ? 'runtime:server' : 'ssh:builder'
      })
      pending.resolve()
      await task

      await vi.waitFor(() => expect(store.getState().prCache[ownerKey]?.data?.number).toBe(22))
      expect(store.getState().prCache[twinKey]).toBe(twinEntry)
      const transport = hostId === 'ssh:builder' ? mockApi.gh.refreshPRNow : runtimeEnvironmentCall
      expect(transport).toHaveBeenCalledTimes(1)
    }
  )

  it.each(
    operations.flatMap((operation) => [
      { operation, selectTwin: true },
      ...(operation === 'push' ? [{ operation, selectTwin: false }] : [])
    ])
  )(
    '$operation refreshes its owner after switching (same-ID twin: $selectTwin)',
    async ({ operation, selectTwin }) => {
      // A paired SSH row from an older listing names only its physical host, not its server owner.
      for (const host of ['local', 'ssh', 'runtime', 'paired-ssh'] as const) {
        const store = createTestStore()
        const paired = host === 'paired-ssh'
        const owner: Repo = {
          ...repo,
          ...(host === 'ssh' || paired ? { connectionId: 'builder' } : {}),
          ...(host === 'runtime' || paired ? { executionHostId: 'runtime:server' } : {})
        }
        const hostId = getRepoExecutionHostId(owner)
        const target: RuntimeClientTarget =
          host === 'runtime' || paired
            ? { kind: 'environment', environmentId: 'server' }
            : { kind: 'local' }
        const twinHost = host === 'local' ? 'runtime:other' : 'local'
        const twin: Repo = { ...repo, executionHostId: twinHost }
        const worktree = makePRRefreshWorktree({
          id: 'same-id',
          repoId: repo.id,
          branch,
          hostId: paired ? 'ssh:builder' : hostId
        })
        const ownerKey = `${host === 'local' ? '' : `${hostId}::`}${repo.id}::${branch}`
        const twinKey = `${twinHost === 'local' ? '' : `${twinHost}::`}${repo.id}::${branch}`
        const oldEntry = { data: makePR({ number: 11 }), fetchedAt: Date.now() }
        store.setState({
          ...createGitRemotePushPull(store.setState, store.getState),
          ...createGitRemoteSync(store.setState, store.getState),
          beginRemoteOperation: vi.fn(() => vi.fn()),
          fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
          repos: [twin, owner],
          worktreesByRepo: { [repo.id]: [{ ...worktree, hostId: twinHost }, worktree] },
          activeWorktreeId: worktree.id,
          activeWorkspaceExecutionHostId: paired ? 'ssh:builder' : hostId,
          sshConnectionStates: new Map([
            [
              'builder',
              { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }
            ]
          ]),
          prCache: { [ownerKey]: oldEntry, [twinKey]: oldEntry }
        })
        const pending = Promise.withResolvers<void>()
        const transport =
          operation === 'push'
            ? pushRuntimeGit
            : operation === 'pull'
              ? pullRuntimeGit
              : operation === 'fast-forward'
                ? fastForwardRuntimeGit
                : operation === 'sync'
                  ? fetchRuntimeGit
                  : rebaseRuntimeGitFromBase
        vi.mocked(transport).mockReturnValueOnce(pending.promise)
        const options = { runtimeTarget: target }
        const state = store.getState()
        const task =
          operation === 'push'
            ? state.pushBranch(
                worktree.id,
                worktree.path,
                false,
                owner.connectionId ?? undefined,
                undefined,
                options
              )
            : operation === 'pull'
              ? state.pullBranch(
                  worktree.id,
                  worktree.path,
                  owner.connectionId ?? undefined,
                  undefined,
                  options
                )
              : operation === 'fast-forward'
                ? state.fastForwardBranch(
                    worktree.id,
                    worktree.path,
                    owner.connectionId ?? undefined,
                    undefined,
                    options
                  )
                : operation === 'sync'
                  ? state.syncBranch(
                      worktree.id,
                      worktree.path,
                      owner.connectionId ?? undefined,
                      undefined,
                      options
                    )
                  : state.rebaseFromBase(
                      worktree.id,
                      worktree.path,
                      'main',
                      owner.connectionId ?? undefined,
                      undefined,
                      options
                    )
        store.setState({
          activeWorktreeId: selectTwin ? worktree.id : 'unrelated-workspace',
          activeWorkspaceExecutionHostId: twinHost
        })
        pending.resolve()
        await task
        await vi.waitFor(() => expect(store.getState().prCache[ownerKey]?.data?.number).toBe(22))
        expect(store.getState().prCache[twinKey]).toBe(oldEntry)
      }
    }
  )
})
