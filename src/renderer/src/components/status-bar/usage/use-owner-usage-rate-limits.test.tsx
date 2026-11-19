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
  } = {
    owner: { kind: 'local' },
    distro: null,
    watchers: [],
    callRuntimeRpc: vi.fn()
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
    selector({ settings: null, runtimeEnvironments: [{ id: 'mini', name: 'Mac Mini' }] })
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

  it('withholds every WSL quota across refreshes, settings updates and owner changes', async () => {
    mocks.owner = { kind: 'local' }
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    expect(result.current.rateLimits).toBe(local)
    mocks.distro = 'Ubuntu'
    rerender()
    expect(result.current.rateLimits.claude?.session).toBeNull()
    expect(result.current.rateLimits.codex?.session).toBeNull()
    expect(result.current.rateLimits.inactiveClaudeAccounts).toEqual([])
    expect(result.current.rateLimits.inactiveCodexAccounts).toEqual([])
    await act(async () => {
      await result.current.refreshRemote?.()
    })
    expect(result.current.rateLimits.claude?.session).toBeNull()
    rerender()
    expect(result.current.rateLimits.claude?.session).toBeNull()
    mocks.distro = 'Debian'
    rerender()
    expect(result.current.rateLimits.codex?.session).toBeNull()
    mocks.distro = null
    rerender()
    expect(result.current.rateLimits).toBe(local)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.watchers).toEqual([])
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
