import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../shared/rate-limit-state-factory'
import type { ProviderAccountsSnapshot } from './runtime-provider-accounts-client'

const callRuntimeRpc = vi.fn()
const watchProviderAccounts = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('./runtime-provider-accounts-client', () => ({
  watchProviderAccounts: (...args: unknown[]) => watchProviderAccounts(...args)
}))

const {
  readAccountsSnapshotUsage,
  refreshOwnedRateLimits,
  readOwnedRateLimits,
  watchOwnedRateLimits
} = await import('./runtime-usage-owner-client')

function snapshot(overrides: Partial<ProviderAccountsSnapshot> = {}): ProviderAccountsSnapshot {
  return {
    claude: {
      accounts: [],
      activeAccountId: 'account-b',
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: [],
      activeAccountId: 'codex-b',
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    rateLimits: createEmptyRateLimitState(),
    ...overrides
  } as ProviderAccountsSnapshot
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
  watchProviderAccounts.mockReset()
  vi.stubGlobal('window', { api: { rateLimits: { get: vi.fn(), refresh: vi.fn() } } })
})

describe('readAccountsSnapshotUsage', () => {
  it('carries the owner account ids as attribution', () => {
    expect(readAccountsSnapshotUsage(snapshot(), 'Remote B')).toMatchObject({
      kind: 'usage',
      claudeAccountId: 'account-b',
      codexAccountId: 'codex-b'
    })
  })

  // A host that predates the field omits it. Absence is unknown, never "no
  // usage" and never a licence to answer with this machine's numbers.
  it('reports an explicit unavailable when the host omits the usage field', () => {
    const fromOldHost = snapshot()
    delete (fromOldHost as { rateLimits?: unknown }).rateLimits

    const reading = readAccountsSnapshotUsage(fromOldHost, 'Remote B')

    expect(reading).toEqual({
      kind: 'unavailable',
      unavailable: {
        reason: 'unsupported-host',
        message:
          'Remote B does not report provider usage. Update the remote Orca server to see it here.'
      }
    })
  })
})

describe('owner-scoped usage requests', () => {
  it('forces a provider refresh on the owning runtime for a manual refresh', async () => {
    callRuntimeRpc.mockResolvedValue(snapshot())

    await refreshOwnedRateLimits('runtime:env-b', 'Remote B')

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-b' },
      'accounts.list',
      { refreshUsage: true },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('reads without forcing a refresh on the initial load', async () => {
    callRuntimeRpc.mockResolvedValue(snapshot())

    await readOwnedRateLimits('runtime:env-b', 'Remote B')

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      expect.anything(),
      'accounts.list',
      { refreshUsage: false },
      expect.anything()
    )
  })

  it('reports an unreachable owner rather than answering locally', async () => {
    callRuntimeRpc.mockRejectedValue(new Error('connection closed'))

    const reading = await refreshOwnedRateLimits('runtime:env-b', 'Remote B')

    expect(reading).toMatchObject({ kind: 'unavailable' })
    expect(window.api.rateLimits.refresh).not.toHaveBeenCalled()
  })

  it('reads local usage from the desktop service for the local owner', async () => {
    const localState = createEmptyRateLimitState()
    vi.mocked(window.api.rateLimits.refresh).mockResolvedValue(localState)

    const reading = await refreshOwnedRateLimits('local', 'This computer')

    expect(reading).toEqual({
      kind: 'usage',
      state: localState,
      claudeAccountId: null,
      codexAccountId: null
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // A direct-SSH host is not dispatchable on this client path; answering
  // locally would report a different machine's accounts.
  it('refuses to answer locally for a non-dispatchable host', async () => {
    const reading = await refreshOwnedRateLimits('ssh:box' as never, 'box')

    expect(reading).toMatchObject({ kind: 'unavailable' })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('watchOwnedRateLimits', () => {
  it('streams the owning runtime accounts snapshot as usage readings', () => {
    const close = vi.fn()
    watchProviderAccounts.mockImplementation((_settings, handlers) => {
      handlers.onSnapshot(snapshot())
      return { close }
    })
    const readings: unknown[] = []

    const watcher = watchOwnedRateLimits('runtime:env-b', 'Remote B', (r) => readings.push(r))

    expect(watchProviderAccounts).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'env-b' },
      expect.anything()
    )
    expect(readings).toHaveLength(1)
    expect(readings[0]).toMatchObject({ kind: 'usage', claudeAccountId: 'account-b' })
    watcher.close()
    expect(close).toHaveBeenCalled()
  })

  it('turns a lost subscription into unavailable, never into local usage', () => {
    watchProviderAccounts.mockImplementation((_settings, handlers) => {
      handlers.onError(new Error('subscription closed'))
      return { close: vi.fn() }
    })
    const readings: { kind: string }[] = []

    watchOwnedRateLimits('runtime:env-b', 'Remote B', (r) => readings.push(r as { kind: string }))

    expect(readings[0]).toMatchObject({
      kind: 'unavailable',
      unavailable: { reason: 'unreachable-host' }
    })
  })

  // The owner answered, then the link dropped. Elapsed silence observes
  // nothing about its quota, so the reading it gave stands — marked, not wiped.
  it('keeps the last reading and marks it unconfirmed when contact is lost', () => {
    let handlers: {
      onSnapshot: (s: ProviderAccountsSnapshot) => void
      onContactLost: () => void
    } | null = null
    watchProviderAccounts.mockImplementation((_settings, given) => {
      handlers = given
      return { close: vi.fn() }
    })
    const readings: { kind: string }[] = []

    watchOwnedRateLimits('runtime:env-b', 'Remote B', (r) => readings.push(r as { kind: string }))
    handlers!.onSnapshot(snapshot())
    handlers!.onContactLost()

    expect(readings.map((reading) => reading.kind)).toEqual(['usage', 'contact-lost'])
    expect(readings[1]).toMatchObject({
      message: 'Lost contact with Remote B. Showing the last usage it reported.'
    })
  })

  it('reports a stream error after a snapshot as lost contact, not unavailable', () => {
    let handlers: {
      onSnapshot: (s: ProviderAccountsSnapshot) => void
      onError: (error: unknown) => void
    } | null = null
    watchProviderAccounts.mockImplementation((_settings, given) => {
      handlers = given
      return { close: vi.fn() }
    })
    const readings: { kind: string }[] = []

    watchOwnedRateLimits('runtime:env-b', 'Remote B', (r) => readings.push(r as { kind: string }))
    handlers!.onSnapshot(snapshot())
    handlers!.onError(new Error('socket closed'))

    expect(readings[1]).toMatchObject({ kind: 'contact-lost' })
  })

  it('does not open a remote subscription for the local owner', () => {
    watchOwnedRateLimits('local', 'This computer', vi.fn())

    expect(watchProviderAccounts).not.toHaveBeenCalled()
  })
})
