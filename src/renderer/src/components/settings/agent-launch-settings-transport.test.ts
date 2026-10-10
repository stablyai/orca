import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.supports
}))
import {
  readHostAgentLaunchSettings,
  mutateHostAgentLaunchSettings
} from './agent-launch-settings-transport'

beforeEach(() => {
  rpc.call.mockReset()
  rpc.supports.mockReset().mockResolvedValue(true)
  rpc.call.mockResolvedValue({
    settings: projectAgentLaunchSettings({ agentDefaultArgs: { claude: '--host' } })
  })
})

describe('host agent launch settings transport', () => {
  it('reads and writes the same captured peer without a desktop settings write', async () => {
    const owner = { environmentId: 'ssh-host', pairingRevision: 17 }
    const signal = new AbortController().signal
    const settings = await readHostAgentLaunchSettings(owner, signal)
    await mutateHostAgentLaunchSettings(
      owner,
      { type: 'arguments', agent: 'claude', value: '--marker' },
      signal
    )
    expect(settings?.agentDefaultArgs.claude).toBe('--host')
    expect(rpc.call.mock.calls).toEqual([
      [
        { kind: 'environment', environmentId: 'ssh-host' },
        'settings.getAgentLaunch',
        undefined,
        { expectedEnvironmentPairingRevision: 17, signal, timeoutMs: 15000 }
      ],
      [
        { kind: 'environment', environmentId: 'ssh-host' },
        'settings.mutateAgentLaunch',
        { type: 'arguments', agent: 'claude', value: '--marker' },
        { expectedEnvironmentPairingRevision: 17, signal, timeoutMs: 15000 }
      ]
    ])
  })

  it('sends no new method or strict-schema field to an old server', async () => {
    rpc.supports.mockResolvedValue(false)
    expect(await readHostAgentLaunchSettings({ environmentId: 'old' })).toBeNull()
    await expect(
      mutateHostAgentLaunchSettings(
        { environmentId: 'old' },
        { type: 'permissions', mode: 'manual' }
      )
    ).rejects.toThrow('unsupported')
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('does not retry an unavailable host against the local settings store', async () => {
    rpc.call.mockRejectedValue(new Error('unavailable'))
    await expect(readHostAgentLaunchSettings({ environmentId: 'offline' })).rejects.toThrow(
      'unavailable'
    )
    expect(rpc.call).toHaveBeenCalledTimes(1)
    expect(rpc.call.mock.calls[0]?.[0]).toEqual({ kind: 'environment', environmentId: 'offline' })
  })
})
