import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeOwner: vi.fn(),
  getSshConnectionId: vi.fn(),
  assertCapability: vi.fn(),
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ marker: 'state' }) }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (...args: unknown[]) => mocks.getRuntimeOwner(...args),
  getSshConnectionIdForWorktree: (...args: unknown[]) => mocks.getSshConnectionId(...args)
}))

vi.mock('./runtime-rpc-client', () => ({
  getActiveRuntimeTarget: ({
    activeRuntimeEnvironmentId
  }: {
    activeRuntimeEnvironmentId: string
  }) =>
    activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: activeRuntimeEnvironmentId }
      : { kind: 'local' },
  assertRuntimeEnvironmentCapability: (...args: unknown[]) => mocks.assertCapability(...args),
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))

import { listDatabaseProfiles, testDatabaseConnection } from './runtime-database-client'

const request = {
  connection: {
    providerId: 'postgres' as const,
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
    user: 'developer',
    sslMode: 'disable' as const
  },
  credential: { password: 'memory-only' }
}

describe('runtime database client project routing', () => {
  beforeEach(() => {
    mocks.getRuntimeOwner.mockReset().mockReturnValue('linux-jae')
    mocks.getSshConnectionId.mockReset().mockReturnValue('ssh-p8')
    mocks.assertCapability.mockReset().mockResolvedValue(undefined)
    mocks.callRuntimeRpc.mockReset().mockResolvedValue({
      database: 'app',
      serverVersion: '17.2'
    })
  })

  it('calls the owning runtime and asks it to use the project SSH connection', async () => {
    await testDatabaseConnection('aps::worktree', request)

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'linux-jae',
      'database.query.v1',
      expect.any(String),
      35_000
    )
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'linux-jae' },
      'database.testConnection',
      {
        ...request,
        execution: { kind: 'ssh', connectionId: 'ssh-p8' }
      },
      { timeoutMs: 35_000 }
    )
  })

  it('keeps a local project on the local runtime without SSH context', async () => {
    mocks.getRuntimeOwner.mockReturnValue(null)
    mocks.getSshConnectionId.mockReturnValue(null)

    await testDatabaseConnection('aps::local', request)

    expect(mocks.assertCapability).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'database.testConnection',
      request,
      { timeoutMs: 35_000 }
    )
  })

  it('scopes saved profiles to the project SSH node on the owning runtime', async () => {
    mocks.callRuntimeRpc.mockResolvedValueOnce({ profiles: [] })

    await listDatabaseProfiles('aps::worktree')

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'linux-jae',
      'database.profile.v1',
      expect.any(String),
      10_000
    )
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'linux-jae' },
      'database.profiles.list',
      { execution: { kind: 'ssh', connectionId: 'ssh-p8' } },
      { timeoutMs: 10_000 }
    )
  })
})
