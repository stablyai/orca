import { ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callAntigravityAccounts } from './runtime-antigravity-accounts-client'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: vi.fn(),
  callRuntimeRpc: vi.fn()
}))
beforeEach(() => {
  setLocalRuntimeCapabilitiesForTests([ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY])
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
      { runtime: 'wsl', wslDistro: 'Ubuntu', expectedAuthorityId: 'a'.repeat(64) },
      'Select',
      'account-b'
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host-b' },
      'accounts.antigravitySelect',
      {
        target: { runtime: 'wsl', wslDistro: 'Ubuntu', expectedAuthorityId: 'a'.repeat(64) },
        accountId: 'account-b'
      },
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
      { runtime: 'wsl', wslDistro: 'Debian', expectedAuthorityId: 'a'.repeat(64) },
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
      { runtime: 'wsl', wslDistro: 'Debian', expectedAuthorityId: 'a'.repeat(64) },
      { timeoutMs: 20_000 }
    )
  })
})

it('requires the distinct WSL capability from the owning peer before sending new fields', async () => {
  vi.mocked(assertRuntimeEnvironmentCapability).mockImplementation(async (_, capability) => {
    if (capability === ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY) {
      throw new Error('WSL unsupported')
    }
  })
  await expect(
    callAntigravityAccounts(
      { kind: 'environment', environmentId: 'old-peer' },
      { runtime: 'wsl', wslDistro: null, expectedAuthorityId: 'a'.repeat(64) },
      'AddCurrent'
    )
  ).rejects.toThrow('WSL unsupported')
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})
it('refuses unsupported local WSL hosts before any RPC', async () => {
  setLocalRuntimeCapabilitiesForTests([])
  await expect(
    callAntigravityAccounts({ kind: 'local' }, { runtime: 'wsl' }, 'List')
  ).rejects.toThrow('WSL')
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})
it('refuses a WSL mutation without an observed binding', async () => {
  await expect(
    callAntigravityAccounts({ kind: 'local' }, { runtime: 'wsl' }, 'AddCurrent')
  ).rejects.toThrow('reload Accounts')
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})
