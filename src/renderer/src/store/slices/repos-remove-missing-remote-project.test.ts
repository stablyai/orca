/**
 * #11994: a project deleted on the paired Orca host stayed in the client's sidebar and
 * could not be removed there. `repo.rm` answers `repo_not_found` (it is already gone on
 * the host) and `removeProject` wrapped its whole body in one try/catch, so the rejection
 * aborted the local purge before the `set()` — the ghost row survived and nothing was
 * surfaced to the user. Only `repo_not_found` is tolerated; any other failure must keep
 * the row, and the error toast is opt-in so bulk/background callers stay silent.
 *
 * A later pass splits "any other failure" in two. A host that answers and refuses is a failure and
 * toasts as before. A host that never answers is `owner-unverifiable`: the row is still kept —
 * its catalog was not touched — but the caller is told so it can offer the client-only forget,
 * so the store does not spend a dead-end toast on it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const staleRemoteRepo: Repo = {
  id: 'project-b',
  path: '/Users/mini/project-b',
  displayName: 'Project B',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'runtime:env-1'
}

const liveRemoteRepo: Repo = {
  id: 'project-a',
  path: '/Users/mini/project-a',
  displayName: 'Project A',
  badgeColor: '#111',
  addedAt: 2,
  executionHostId: 'runtime:env-1'
}

const localTwinRepo: Repo = {
  id: 'project-b',
  path: '/Users/laptop/project-b',
  displayName: 'Project B (local)',
  badgeColor: '#222',
  addedAt: 3
}

const reposRemove = vi.fn()
const reposRemoveForHost = vi.fn()
const ptyKill = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

function answerRepoRmWith(code: string): void {
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'repo.rm') {
      return {
        id: 'rpc-repo-rm',
        ok: false,
        error: { code, message: code },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    return { id: 'rpc-other', ok: true, result: {}, _meta: { runtimeId: 'runtime-remote' } }
  })
}

function seedRemoteProjects(repos: readonly Repo[]): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
    repos: [...repos]
  })
  return store
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.mocked(toast.error).mockReset()
  for (const mock of [
    reposRemove,
    reposRemoveForHost,
    ptyKill,
    runtimeEnvironmentCall,
    runtimeEnvironmentTransportCall
  ]) {
    mock.mockReset()
  }
  runtimeEnvironmentTransportCall.mockImplementation(
    (args: RuntimeEnvironmentCallRequest) =>
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  )
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

describe('removeProject when the owning host already dropped the project', () => {
  it('drops the ghost row when the remote reports repo_not_found', async () => {
    answerRepoRmWith('repo_not_found')
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo])

    await store.getState().removeProject('project-b', { hostId: 'runtime:env-1' })

    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['project-a'])
  })

  it('keeps the row and stays silent when the remote refuses', async () => {
    answerRepoRmWith('unauthorized')
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo])

    const outcome = await store.getState().removeProject('project-b', { hostId: 'runtime:env-1' })

    expect(outcome).toEqual({ status: 'failed' })
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['project-a', 'project-b'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts once for a genuine failure when the caller opts in', async () => {
    answerRepoRmWith('unauthorized')
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo])

    await store
      .getState()
      .removeProject('project-b', { hostId: 'runtime:env-1', errorFeedback: 'toast' })

    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('reports owner-unverifiable without a toast when the host never answers', async () => {
    answerRepoRmWith('runtime_unavailable')
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo])

    const outcome = await store
      .getState()
      .removeProject('project-b', { hostId: 'runtime:env-1', errorFeedback: 'toast' })

    // The host's catalog was never reached, so the row must survive: a purge here would claim
    // a removal that did not happen.
    expect(outcome).toEqual({ status: 'owner-unverifiable' })
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['project-a', 'project-b'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  // The client refuses to dispatch to an environment the user disconnected, so the host answered
  // nothing. Classified as a refusal this reported `failed` and the dialog offered no way out.
  it('reports owner-unverifiable when the client never dispatched to a disconnected host', async () => {
    answerRepoRmWith('runtime_manually_disconnected')
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo])

    const outcome = await store
      .getState()
      .removeProject('project-b', { hostId: 'runtime:env-1', errorFeedback: 'toast' })

    expect(outcome).toEqual({ status: 'owner-unverifiable' })
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['project-a', 'project-b'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('forget-local clears the row without ever calling the unreachable host', async () => {
    answerRepoRmWith('runtime_unavailable')
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo])

    const outcome = await store
      .getState()
      .removeProject('project-b', { hostId: 'runtime:env-1', mode: 'forget-local' })

    expect(outcome).toEqual({ status: 'removed' })
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['project-a'])
    // Nothing at all is asked of the host — not the removal, not the terminal teardown.
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    // Host-scoped so a same-id row on another host keeps its own records.
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: 'project-b',
      hostId: 'runtime:env-1'
    })
    expect(reposRemove).not.toHaveBeenCalled()
  })

  it('leaves a same-id project on another host untouched', async () => {
    answerRepoRmWith('repo_not_found')
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo, localTwinRepo])

    await store.getState().removeProject('project-b', { hostId: 'runtime:env-1' })

    expect(store.getState().repos.map((repo) => repo.path)).toEqual([
      '/Users/mini/project-a',
      '/Users/laptop/project-b'
    ])
  })
})
