import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_BALANCE_CAPABILITY,
  unsupportedDeepSeekAccount
} from '../../../shared/deepseek-balance'
import {
  readDeepSeekAccount,
  mutateDeepSeekAccount,
  refreshDeepSeekAccount
} from './deepseek-account-client'

const rpc = vi.hoisted(() => ({ call: vi.fn(), local: vi.fn(), remote: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.remote
}))
vi.mock('./local-runtime-capabilities', () => ({ ensureLocalRuntimeCapabilities: rpc.local }))

describe('DeepSeek account host routing', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    rpc.local.mockResolvedValue([DEEPSEEK_BALANCE_CAPABILITY])
    rpc.remote.mockResolvedValue(true)
  })

  it.each([undefined, []])(
    'treats missing local capabilities as unsupported (%s)',
    async (capabilities) => {
      rpc.local.mockResolvedValue(capabilities)
      expect(await readDeepSeekAccount({ kind: 'local' })).toEqual(unsupportedDeepSeekAccount())
      await expect(
        mutateDeepSeekAccount({ kind: 'local' }, 'host', 'save', 'synthetic')
      ).rejects.toThrow('unsupported')
      expect(rpc.call).not.toHaveBeenCalled()
    }
  )

  it('never falls back to the desktop when an old remote host lacks the optional capability', async () => {
    rpc.remote.mockResolvedValue(false)
    const target = { kind: 'environment', environmentId: 'old-host' } as const
    expect(await readDeepSeekAccount(target)).toEqual(unsupportedDeepSeekAccount())
    await expect(refreshDeepSeekAccount(target, 'old-owner')).rejects.toThrow('unsupported')
    expect(rpc.call).not.toHaveBeenCalled()
    expect(rpc.local).not.toHaveBeenCalled()
  })

  it('sends write-only entry once to the captured owner and does not send a key for reads or removal', async () => {
    const target = { kind: 'environment', environmentId: 'paired-host' } as const
    const status = {
      supported: true,
      configured: true,
      ownerId: 'owner',
      protection: 'sealed'
    } as const
    rpc.call.mockResolvedValue(status)
    expect(await mutateDeepSeekAccount(target, 'owner', 'save', 'synthetic')).toEqual(status)
    expect(rpc.call).toHaveBeenLastCalledWith(
      target,
      'accounts.saveDeepSeekApiKey',
      { ownerId: 'owner', apiKey: 'synthetic' },
      { expectedEnvironmentRuntimeId: 'owner' }
    )
    await mutateDeepSeekAccount(target, 'owner', 'remove')
    expect(rpc.call).toHaveBeenLastCalledWith(
      target,
      'accounts.removeDeepSeekApiKey',
      { ownerId: 'owner' },
      { expectedEnvironmentRuntimeId: 'owner' }
    )
    await readDeepSeekAccount(target)
    expect(rpc.call).toHaveBeenLastCalledWith(target, 'accounts.deepSeekStatus')
    await refreshDeepSeekAccount(target, 'owner')
    expect(rpc.call).toHaveBeenLastCalledWith(
      target,
      'accounts.refreshDeepSeek',
      { ownerId: 'owner' },
      { timeoutMs: 20_000, expectedEnvironmentRuntimeId: 'owner' }
    )
    expect(rpc.local).not.toHaveBeenCalled()
  })
})
