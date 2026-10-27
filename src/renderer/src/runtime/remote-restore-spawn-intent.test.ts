import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runtimeEnvironmentSupportsCapability } = vi.hoisted(() => ({
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability }))

import { remoteRestoreSpawnIntentParams } from './remote-restore-spawn-intent'

describe('remoteRestoreSpawnIntentParams', () => {
  beforeEach(() => {
    runtimeEnvironmentSupportsCapability.mockReset()
  })

  it('declares the intent to a host that advertises it', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    await expect(remoteRestoreSpawnIntentParams('env-1', 'user-resume')).resolves.toEqual({
      spawnIntent: 'user-resume'
    })
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      'terminal.spawn-intent.v1'
    )
  })

  it('sends nothing to an older host or when the probe fails', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValueOnce(false)
    await expect(remoteRestoreSpawnIntentParams('env-1', 'user-resume')).resolves.toEqual({})
    runtimeEnvironmentSupportsCapability.mockRejectedValueOnce(new Error('offline'))
    await expect(remoteRestoreSpawnIntentParams('env-1', 'automatic-restore')).resolves.toEqual({})
  })
})
