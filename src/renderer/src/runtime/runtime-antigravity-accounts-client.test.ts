import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callAntigravityAccounts } from './runtime-antigravity-accounts-client'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: vi.fn(),
  callRuntimeRpc: vi.fn()
}))
beforeEach(() => {
  vi.mocked(assertRuntimeEnvironmentCapability).mockReset().mockResolvedValue()
  vi.mocked(callRuntimeRpc).mockReset().mockResolvedValue({ accounts: [] })
})

describe('Antigravity account execution-host routing', () => {
  it('refuses an old remote host before any account operation reaches a local or remote store', async () => {
    vi.mocked(assertRuntimeEnvironmentCapability).mockRejectedValue(
      new Error('old host unsupported')
    )
    await expect(
      callAntigravityAccounts(
        { kind: 'environment', environmentId: 'host-a' },
        { runtime: 'host' },
        'Select',
        'account-a'
      )
    ).rejects.toThrow('old host unsupported')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends selection only to the specified owning host and includes the exact distro', async () => {
    await callAntigravityAccounts(
      { kind: 'environment', environmentId: 'host-b' },
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      'Select',
      'account-b'
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host-b' },
      'accounts.antigravitySelect',
      { target: { runtime: 'wsl', wslDistro: 'Ubuntu' }, accountId: 'account-b' },
      { timeoutMs: 20_000 }
    )
  })

  it('does not silently switch to the client store when the owning host rejects selection', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('host unavailable'))
    await expect(
      callAntigravityAccounts(
        { kind: 'environment', environmentId: 'host-a' },
        { runtime: 'host' },
        'Select',
        'account-a'
      )
    ).rejects.toThrow('host unavailable')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('keeps host and distro lists separate and never drops the target', async () => {
    await callAntigravityAccounts({ kind: 'local' }, { runtime: 'host' }, 'List')
    await callAntigravityAccounts(
      { kind: 'local' },
      { runtime: 'wsl', wslDistro: 'Debian' },
      'AddCurrent'
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'local' },
      'accounts.antigravityList',
      { runtime: 'host' },
      { timeoutMs: 20_000 }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'accounts.antigravityAddCurrent',
      { runtime: 'wsl', wslDistro: 'Debian' },
      { timeoutMs: 20_000 }
    )
  })
})
