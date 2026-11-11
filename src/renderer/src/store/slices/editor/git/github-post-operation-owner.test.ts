import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import '../../../../../../shared/execution-host'
import { createGitRemotePushPull } from './git-remote-push-pull'
import './git-remote-sync'
import { pushRuntimeGit } from '../../../../runtime/source-control/git/runtime-git-sync-client'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../../../github/github-slice-test-harness'

vi.mock('../../../../runtime/source-control/git/runtime-git-sync-client', () => ({
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
    }
  )
})
