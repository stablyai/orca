import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc, runtimeEnvironmentSupportsCapability } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async () => ({})),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability
}))

import {
  canResumeHostAutomaticRestores,
  resumeHostAutomaticRestores
} from './resume-host-automatic-restores'

describe('host automatic-restore resume', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('offers the action for this app, and for a paired host only when it advertises it', async () => {
    await expect(canResumeHostAutomaticRestores(null)).resolves.toBe(true)
    runtimeEnvironmentSupportsCapability.mockResolvedValueOnce(true)
    await expect(canResumeHostAutomaticRestores('env-1')).resolves.toBe(true)
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      'runtime.automatic-work.v1'
    )
    runtimeEnvironmentSupportsCapability.mockResolvedValueOnce(false)
    await expect(canResumeHostAutomaticRestores('env-old')).resolves.toBe(false)
    runtimeEnvironmentSupportsCapability.mockRejectedValueOnce(new Error('offline'))
    await expect(canResumeHostAutomaticRestores('env-down')).resolves.toBe(false)
  })

  it('asks the host that owns the pane', async () => {
    await resumeHostAutomaticRestores('env-1')
    await resumeHostAutomaticRestores(null)
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'env-1' },
      'runtime.automaticWork.resume'
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'runtime.automaticWork.resume'
    )
  })
})
