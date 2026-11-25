// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'

type Handlers = {
  onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
  onError: (error: unknown) => void
  onClosedAfterSnapshot?: () => void
}

type Watcher = { target: RuntimeClientTarget; handlers: Handlers; closed: boolean }

const mocks = vi.hoisted(() => {
  const state: {
    owner: RuntimeClientTarget | null
    distro: string | null
    watchers: Watcher[]
    callRuntimeRpc: Mock
    readUsageForRuntimeTarget: Mock
    settings: unknown
  } = {
    owner: { kind: 'local' },
    distro: null,
    watchers: [],
    callRuntimeRpc: vi.fn(),
    readUsageForRuntimeTarget: vi.fn(),
    settings: null
  }
  return state
})

vi.mock('@/runtime/provider-accounts/ownership/use-active-account-owner', () => ({
  useActiveAccountOwner: () =>
    mocks.owner ? { target: mocks.owner, wslHostDistro: mocks.distro } : null
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/runtime/provider-accounts/observations/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: (target: RuntimeClientTarget, handlers: Handlers) => {
    const watcher = { target, handlers, closed: false }
    mocks.watchers.push(watcher)
    return {
      close: () => {
        watcher.closed = true
      }
    }
  }
}))
vi.mock('../../../store/index', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: mocks.settings, runtimeEnvironments: [{ id: 'mini', name: 'Mac Mini' }] })
}))

const { useOwnerUsageRateLimits } = await import('./use-owner-usage-rate-limits')

function provider(id: ProviderRateLimits['provider'], usedPercent: number): ProviderRateLimits {
  return {
    provider: id,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function snapshot(rateLimits: ProviderAccountsSnapshot['rateLimits']): ProviderAccountsSnapshot {
  const empty = {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }
  return { claude: empty, codex: empty, rateLimits }
}

const local = createEmptyRateLimitState({ claude: provider('claude', 11) })

describe('useOwnerUsageRateLimits', () => {
  beforeEach(() => {
    mocks.owner = { kind: 'local' }
    mocks.distro = null
    mocks.watchers.length = 0
    mocks.callRuntimeRpc.mockReset()
    mocks.readUsageForRuntimeTarget.mockReset().mockReturnValue(new Promise(() => {}))
    mocks.settings = null
    Object.assign(window, {
      api: { rateLimits: { readUsageForRuntimeTarget: mocks.readUsageForRuntimeTarget } }
    })
  })
  afterEach(() => cleanup())

  it('never shows server A numbers under server B', () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    const first = mocks.watchers[0]
    act(() =>
      first.handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 90) }))
      )
    )
    mocks.owner = { kind: 'environment', environmentId: 'devbox' }
    rerender()
    expect(first.closed).toBe(true)
    expect(result.current.rateLimits.claude?.session).toBeNull()
    act(() =>
      first.handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 91) }))
      )
    )
    expect(result.current.rateLimits.claude?.session).toBeNull()
  })

  it('does not retain A across an intervening owner with no snapshot', () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    act(() =>
      mocks.watchers[0].handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 90) }))
      )
    )
    mocks.owner = { kind: 'environment', environmentId: 'devbox' }
    rerender()
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    rerender()
    expect(result.current.rateLimits.claude?.session).toBeNull()
    act(() =>
      mocks.watchers[2].handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 20) }))
      )
    )
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(20)
    act(() => mocks.watchers[2].handlers.onError(new Error('offline')))
    expect(result.current.rateLimits.claude?.session).toBeNull()
  })
  it('ignores a refresh from an earlier activation after returning to the same owner', async () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    let resolveRefresh: (value: ProviderAccountsSnapshot) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValue(
      new Promise<ProviderAccountsSnapshot>((resolve) => {
        resolveRefresh = resolve
      })
    )
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    const pending = result.current.refreshRemote?.()
    mocks.owner = { kind: 'environment', environmentId: 'devbox' }
    rerender()
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    rerender()
    act(() =>
      mocks.watchers[2].handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 20) }))
      )
    )
    await act(async () => {
      resolveRefresh(snapshot(createEmptyRateLimitState({ claude: provider('claude', 99) })))
      await pending
    })
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(20)
  })
  it('withholds local usage and refresh when a visible owner has no account transport', async () => {
    mocks.owner = null
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    expect(result.current.rateLimits.claude?.session).toBeNull()
    expect(result.current.remoteOwner?.environmentId).toBeNull()
    await result.current.refreshRemote?.()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.watchers).toEqual([])
  })

  it("shows a focused WSL host's distro usage, never the host runtime's numbers", async () => {
    mocks.distro = 'Alpine'
    let resolveRead: (value: unknown) => void = () => {}
    mocks.readUsageForRuntimeTarget.mockReturnValue(
      new Promise((resolve) => (resolveRead = resolve))
    )
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    // Pending: no host-runtime number may stand in for the distro's.
    expect(result.current.rateLimits.claude?.session).toBeNull()
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledWith(
      { runtime: 'wsl', wslDistro: 'Alpine' },
      ['claude', 'codex']
    )
    const reading = provider('claude', 77)
    await act(async () => resolveRead({ claude: { accountId: null, reading } }))
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(77)
    mocks.distro = null
    rerender()
    expect(result.current.rateLimits).toBe(local)
  })

  it("drops a distro reading taken for an account that isn't selected", async () => {
    mocks.distro = 'Arch'
    mocks.settings = {
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Arch: 'current' } }
    }
    const reading = provider('claude', 66)
    mocks.readUsageForRuntimeTarget.mockResolvedValue({
      claude: { accountId: 'previous', reading }
    })
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    await act(async () => {})
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalled()
    expect(result.current.rateLimits.claude?.session).toBeNull()
  })

  it('fails closed when this client cannot read the distro', async () => {
    mocks.distro = 'Fedora'
    mocks.readUsageForRuntimeTarget.mockResolvedValue(null)
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    await act(async () => {})
    expect(result.current.rateLimits.claude?.usageMetadata?.unverifiableOwner).toBe(true)
    expect(result.current.rateLimits.claude?.session).toBeNull()
  })

  it('keeps a forced refresh from re-reading inside a Retry-After window', async () => {
    mocks.distro = 'Gentoo'
    const reading = {
      ...provider('claude', 50),
      // A fixed far-future deadline: the window is still active whenever this runs.
      usageMetadata: { retryAtMs: 4_102_444_800_000 }
    }
    mocks.readUsageForRuntimeTarget.mockResolvedValue({ claude: { accountId: null, reading } })
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    await act(async () => {})
    await act(async () => {
      await result.current.refreshRemote?.()
    })
    // Only Codex, which carries no Retry-After, is read again.
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenLastCalledWith(
      { runtime: 'wsl', wslDistro: 'Gentoo' },
      ['codex']
    )
  })

  it('keeps a provider the desktop already fetches for the distro live while the other reads', () => {
    mocks.distro = 'Kali'
    const liveLocal = createEmptyRateLimitState({
      claude: provider('claude', 33),
      claudeTarget: { runtime: 'wsl', wslDistro: 'Kali' }
    })
    const { result } = renderHook(() => useOwnerUsageRateLimits(liveLocal))
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledWith(
      { runtime: 'wsl', wslDistro: 'Kali' },
      ['codex']
    )
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(33)
    expect(result.current.rateLimits.codex?.status).toBe('fetching')
  })

  it('never retains a paired snapshot when a WSL chat becomes visible', () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    const paired = mocks.watchers[0]
    act(() =>
      paired.handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 90) }))
      )
    )
    mocks.owner = { kind: 'local' }
    mocks.distro = 'Ubuntu'
    rerender()
    expect(paired.closed).toBe(true)
    expect(result.current.rateLimits.claude?.session).toBeNull()
    act(() =>
      paired.handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 99) }))
      )
    )
    expect(result.current.rateLimits.claude?.session).toBeNull()
    mocks.distro = null
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    rerender()
    expect(result.current.rateLimits.claude?.session).toBeNull()
    act(() =>
      mocks.watchers[1].handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 20) }))
      )
    )
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(20)
  })
})
