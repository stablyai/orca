import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY } from '../../../../shared/repository-add-script-runtime-capabilities'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.supports
}))

import {
  readHostRepositoryAddScript,
  writeHostRepositoryAddScript
} from './repository-add-script-setting-transport'

beforeEach(() => {
  rpc.call.mockReset()
  rpc.supports.mockReset().mockResolvedValue(true)
  rpc.call.mockResolvedValue({ settings: {} })
})

describe('repository add script host transport', () => {
  it('reads the opted-in script from the chosen server', async () => {
    const owner = { environmentId: 'ssh-host', pairingRevision: 17 }
    const signal = new AbortController().signal
    rpc.call.mockResolvedValue({ settings: { repositoryAddScript: 'echo host' } })

    await expect(readHostRepositoryAddScript(owner, signal)).resolves.toBe('echo host')
    expect(rpc.supports).toHaveBeenCalledWith('ssh-host', REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY)
    expect(rpc.call.mock.calls).toEqual([
      [
        { kind: 'environment', environmentId: 'ssh-host' },
        'settings.get',
        { includeRepositoryAddScript: true },
        { expectedEnvironmentPairingRevision: 17, signal, timeoutMs: 15000 }
      ]
    ])
  })

  it('reports an absent script as empty text', async () => {
    await expect(readHostRepositoryAddScript({ environmentId: 'ssh-host' })).resolves.toBe('')
  })

  it('sends nothing to a server without the capability', async () => {
    rpc.supports.mockResolvedValue(false)

    await expect(readHostRepositoryAddScript({ environmentId: 'old-host' })).resolves.toBeNull()
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('writes the script and returns the host echo', async () => {
    const owner = { environmentId: 'ssh-host', pairingRevision: 17 }
    const signal = new AbortController().signal
    rpc.call.mockResolvedValue({ settings: { repositoryAddScript: 'echo normalized' } })

    await expect(writeHostRepositoryAddScript(owner, 'echo edited', signal)).resolves.toBe(
      'echo normalized'
    )
    expect(rpc.call.mock.calls).toEqual([
      [
        { kind: 'environment', environmentId: 'ssh-host' },
        'settings.update',
        { repositoryAddScript: 'echo edited', includeRepositoryAddScript: true },
        { expectedEnvironmentPairingRevision: 17, signal, timeoutMs: 15000 }
      ]
    ])
  })

  it('reports a missing echo for a non-empty script as an unverified write', async () => {
    rpc.call.mockResolvedValue({ settings: {} })

    await expect(
      writeHostRepositoryAddScript({ environmentId: 'ssh-host' }, 'echo edited')
    ).resolves.toBeNull()
  })

  it('treats a blank script without an echo as cleared', async () => {
    rpc.call.mockResolvedValue({ settings: {} })

    await expect(writeHostRepositoryAddScript({ environmentId: 'ssh-host' }, '')).resolves.toBe('')
    await expect(writeHostRepositoryAddScript({ environmentId: 'ssh-host' }, '  \n')).resolves.toBe(
      ''
    )
  })

  it('reports an unsupported write without sending it', async () => {
    rpc.supports.mockResolvedValue(false)

    await expect(
      writeHostRepositoryAddScript({ environmentId: 'old-host' }, 'echo')
    ).rejects.toThrow('Update this Orca server')
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('does not retry or fall back when the host is unreachable', async () => {
    rpc.call.mockRejectedValue(new Error('offline'))

    await expect(
      writeHostRepositoryAddScript({ environmentId: 'offline' }, 'echo')
    ).rejects.toThrow('offline')
    expect(rpc.call).toHaveBeenCalledTimes(1)
    expect(rpc.call.mock.calls[0]?.[0]).toEqual({ kind: 'environment', environmentId: 'offline' })
  })
})
