import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from './runtime-provider-account-selection'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))

const remote = { kind: 'environment' as const, environmentId: 'paired' }

describe('remote provider account selection', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    mocks.rpc.mockResolvedValue({ accounts: [], activeAccountId: null })
  })

  it('keeps the WSL target when Codex goes back to the system default', async () => {
    await selectCodexProviderAccount(remote, {
      accountId: null,
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(mocks.rpc).toHaveBeenCalledWith(
      remote,
      'accounts.selectCodexForTarget',
      { accountId: null, target: { runtime: 'wsl', wslDistro: 'Ubuntu' } },
      expect.any(Object)
    )
  })

  it('sends an unnamed WSL distro as the all-distros target', async () => {
    await selectCodexProviderAccount(remote, { accountId: null, runtime: 'wsl', wslDistro: ' ' })

    expect(mocks.rpc).toHaveBeenCalledWith(
      remote,
      'accounts.selectCodexForTarget',
      { accountId: null, target: { runtime: 'wsl', wslDistro: null } },
      expect.any(Object)
    )
  })

  it('keeps concrete WSL account IDs on the plain Codex method for older hosts', async () => {
    await selectCodexProviderAccount(remote, {
      accountId: 'wsl-account',
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(mocks.rpc).toHaveBeenCalledWith(
      remote,
      'accounts.selectCodex',
      { accountId: 'wsl-account' },
      expect.any(Object)
    )
  })

  it('keeps host selections on the plain Codex method', async () => {
    await selectCodexProviderAccount(remote, { accountId: null, runtime: 'host' })

    expect(mocks.rpc).toHaveBeenCalledWith(
      remote,
      'accounts.selectCodex',
      { accountId: null },
      expect.any(Object)
    )
  })

  it('refuses a remote Claude WSL system-default select instead of clearing the host slot', async () => {
    await expect(
      selectClaudeProviderAccount(remote, { accountId: null, runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).rejects.toThrow(/WSL lane/)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
