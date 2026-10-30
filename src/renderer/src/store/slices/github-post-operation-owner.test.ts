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

  it.each(
    operations.flatMap((operation) => [
      { operation, selectTwin: true },
      { operation, selectTwin: false }
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
          beginRemoteOperation: vi.fn(),
          endRemoteOperation: vi.fn(),
          fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
          repos: [twin, owner],
          worktreesByRepo: { [repo.id]: [{ ...worktree, hostId: twinHost }, worktree] },
          activeWorktreeId: worktree.id,
          activeWorkspaceExecutionHostId: worktree.hostId,
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
