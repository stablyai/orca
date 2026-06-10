import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const reposUpdate = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposUpdate.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: { update: reposUpdate },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice worktree folder updates', () => {
  it('sends an explicit worktree folder clear through remote runtime updates', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-clear-worktree-folder',
      ok: true,
      result: { repo: { ...remoteRepo, worktreeFolderPath: undefined } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [{ ...remoteRepo, worktreeFolderPath: '/worktrees/remote' }]
    })

    await store.getState().updateRepo(remoteRepo.id, { worktreeFolderPath: undefined })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.update',
      params: { repo: remoteRepo.id, updates: { worktreeFolderPath: '' } },
      timeoutMs: 15_000
    })
    expect(reposUpdate).not.toHaveBeenCalled()
  })
})
