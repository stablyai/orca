/** Treat only repo_not_found as already removed and purge client ghost rows (#11994). Other failures retain rows; toasts remain opt-in for single-project callers while bulk/background aggregate errors. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'

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
  it('still finishes the removal when the residue cleanup throws', async () => {
    answerRepoRmWith('repo_not_found')
    reposRemoveForHost.mockImplementation(() => {
      throw new Error('Forgetting a host is unavailable in paired web clients.')
    })
    const store = seedRemoteProjects([liveRemoteRepo, staleRemoteRepo])

    await store.getState().removeProject('project-b', { hostId: 'runtime:env-1' })

    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['project-a'])
  })
})
