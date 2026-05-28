import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { abortRuntimeGitMerge } from './runtime-git-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const gitAbortMerge = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  gitAbortMerge.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      git: { abortMerge: gitAbortMerge },
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('runtime git client merge operations', () => {
  it('uses local git IPC when no remote runtime is active', async () => {
    gitAbortMerge.mockResolvedValue(undefined)

    await abortRuntimeGitMerge({
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    expect(gitAbortMerge).toHaveBeenCalledWith({ connectionId: undefined, worktreePath: '/repo' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes abort merge through the active runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { success: true },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await abortRuntimeGitMerge({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.abortMerge',
      params: { worktree: 'wt-1' },
      timeoutMs: 30_000
    })
    expect(gitAbortMerge).not.toHaveBeenCalled()
  })
})
