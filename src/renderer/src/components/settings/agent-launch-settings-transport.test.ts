import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import {
  AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY,
  AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
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

  it('keeps the new automatic permission value out of an older host strict schema', async () => {
    rpc.supports.mockImplementation(
      async (_id, capability) => capability !== AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY
    )
    await expect(
      mutateHostAgentLaunchSettings(
        { environmentId: 'old' },
        { type: 'permissions', agent: 'codex', mode: 'auto' }
      )
    ).rejects.toThrow('agent_launch_auto_permissions_unsupported')
    expect(rpc.call).not.toHaveBeenCalled()
    await mutateHostAgentLaunchSettings(
      { environmentId: 'old' },
      { type: 'permissions', mode: 'manual' }
    )
    expect(rpc.call).toHaveBeenCalledOnce()
  })

  it('keeps scoped Manual out of an older host strict schema too', async () => {
    rpc.supports.mockImplementation(
      async (_id, capability) => capability !== AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY
    )
    await expect(
      mutateHostAgentLaunchSettings(
        { environmentId: 'old' },
        { type: 'permissions', agent: 'codex', mode: 'manual' }
      )
    ).rejects.toThrow('unsupported')
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('sends automatic permissions only to a host that advertises support', async () => {
    await mutateHostAgentLaunchSettings(
      { environmentId: 'new' },
      { type: 'permissions', agent: 'codex', mode: 'auto' }
    )
    expect(rpc.supports).toHaveBeenCalledWith('new', AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY)
    expect(rpc.call.mock.calls[0]?.[2]).toEqual({
      type: 'permissions',
      agent: 'codex',
      mode: 'auto'
    })
  })
})

it('refuses native synchronization against a settings-only host strict schema', async () => {
  rpc.supports.mockImplementation(
    async (_id, capability) => capability !== AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY
  )
  await expect(
    mutateHostAgentLaunchSettings(
      { environmentId: 'settings-only' },
      { type: 'permissions', agent: 'codex', mode: 'auto', syncNativeChat: true }
    )
  ).rejects.toThrow('agent_launch_native_chat_permissions_unsupported')
  expect(rpc.call).not.toHaveBeenCalled()
  await mutateHostAgentLaunchSettings(
    { environmentId: 'settings-only' },
    { type: 'permissions', agent: 'codex', mode: 'auto' }
  )
  expect(rpc.call.mock.calls[0]?.[2]).toEqual({ type: 'permissions', agent: 'codex', mode: 'auto' })
})

it('sends the explicit native synchronization marker only after capability verification', async () => {
  await mutateHostAgentLaunchSettings(
    { environmentId: 'native' },
    { type: 'permissions', mode: 'manual', syncNativeChat: true }
  )
  expect(rpc.supports).toHaveBeenCalledWith(
    'native',
    AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY
  )
  expect(rpc.call.mock.calls[0]?.[2]).toEqual({
    type: 'permissions',
    mode: 'manual',
    syncNativeChat: true
  })
})
