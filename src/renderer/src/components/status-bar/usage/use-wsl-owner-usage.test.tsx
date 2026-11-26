// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'

const mocks = vi.hoisted(() => {
  const state: {
    distro: string | null
    settings: unknown
    focused: boolean
    readUsageForRuntimeTarget: Mock
  } = { distro: null, settings: null, focused: true, readUsageForRuntimeTarget: vi.fn() }
  return state
})

vi.mock('@/runtime/provider-accounts/ownership/use-active-account-owner', () => ({
  useActiveAccountOwner: () => ({ target: { kind: 'local' }, wslHostDistro: mocks.distro })
}))
vi.mock('@/attention/orca-window-foreground-focus', () => ({
  isOrcaWindowForegroundFocused: () => mocks.focused
}))
vi.mock('../../../store/index', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: mocks.settings, runtimeEnvironments: [] })
}))

const { useOwnerUsageRateLimits } = await import('./use-owner-usage-rate-limits')
const { readWslProviderUsage, wslProviderUsageKey } =
  await import('@/runtime/provider-accounts/observations/wsl-owner-usage-store')

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

const local = createEmptyRateLimitState({ claude: provider('claude', 11) })
// A fixed far-future deadline: the window is still active whenever this runs.
const FAR_RETRY_AT_MS = 4_102_444_800_000

describe('WSL host owner usage', () => {
  beforeEach(() => {
    mocks.distro = null
    mocks.settings = null
    mocks.focused = true
    mocks.readUsageForRuntimeTarget.mockReset().mockReturnValue(new Promise(() => {}))
    Object.assign(window, {
      api: { rateLimits: { readUsageForRuntimeTarget: mocks.readUsageForRuntimeTarget } }
    })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
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
      usageMetadata: { retryAtMs: FAR_RETRY_AT_MS }
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

  it('re-reads a provider whose reading main could not attribute', async () => {
    vi.useFakeTimers()
    mocks.distro = 'Void'
    mocks.readUsageForRuntimeTarget.mockResolvedValue({})
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    await act(async () => {})
    expect(result.current.rateLimits.claude?.session).toBeNull()
    const reading = provider('claude', 44)
    mocks.readUsageForRuntimeTarget.mockResolvedValue({ claude: { accountId: null, reading } })
    await act(() => vi.advanceTimersByTimeAsync(6_000))
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(44)
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

  it('backs off re-reads of a provider main keeps failing to attribute', async () => {
    vi.useFakeTimers()
    mocks.distro = 'Nix'
    mocks.readUsageForRuntimeTarget.mockResolvedValue({})
    renderHook(() => useOwnerUsageRateLimits(local))
    await act(async () => {})
    const calls = (): number => mocks.readUsageForRuntimeTarget.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(5_100))
    expect(calls()).toBe(2)
    // The second retry waits 10 s, not 5 s.
    await act(() => vi.advanceTimersByTimeAsync(5_100))
    expect(calls()).toBe(2)
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(calls()).toBe(3)
  })

  it('caps a Retry-After at six hours', async () => {
    vi.useFakeTimers()
    mocks.distro = 'Mint'
    const reading = { ...provider('claude', 50), usageMetadata: { retryAtMs: FAR_RETRY_AT_MS } }
    const claude = { accountId: null, reading }
    mocks.readUsageForRuntimeTarget.mockResolvedValue({ claude, codex: claude })
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    await act(async () => {})
    await act(() => vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 1_000))
    await act(async () => {
      await result.current.refreshRemote?.()
    })
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    await act(async () => {
      await result.current.refreshRemote?.()
    })
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)
  })

  it('does not schedule idle re-reads after an attributed reading, and refreshes on focus or desktop poll', async () => {
    vi.useFakeTimers()
    mocks.distro = 'Suse'
    const reading = provider('claude', 50)
    mocks.readUsageForRuntimeTarget.mockResolvedValue({
      claude: { accountId: null, reading },
      codex: { accountId: null, reading: provider('codex', 25) }
    })
    const { rerender } = renderHook(({ state }) => useOwnerUsageRateLimits(state), {
      initialProps: { state: local }
    })
    await act(async () => {})
    await act(() => vi.advanceTimersByTimeAsync(180_000))
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledTimes(1)

    // Returning focus after the TTL refreshes the distro reading.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)

    // Piggybacking on the desktop poller refreshes after the TTL without its own timer.
    await act(() => vi.advanceTimersByTimeAsync(100_000))
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)
    // A poll push whose desktop stamps did not advance (gated or WSL-only credentials) still counts.
    const polled = { ...local }
    await act(async () => {
      rerender({ state: polled })
    })
    expect(mocks.readUsageForRuntimeTarget).toHaveBeenCalledTimes(3)
  })

  it('evicts cached entries when account or distro owners are removed', async () => {
    mocks.distro = 'Debian'
    const retiredIds = ['acct-1', 'acct-2', 'acct-3']
    const { rerender, unmount } = renderHook(() => useOwnerUsageRateLimits(local))

    for (const id of retiredIds) {
      mocks.settings = {
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Debian: id } }
      }
      mocks.readUsageForRuntimeTarget.mockResolvedValue({
        codex: { accountId: id, reading: provider('codex', 40) }
      })
      rerender()
      await act(async () => {})
      expect(readWslProviderUsage(wslProviderUsageKey('Debian', 'codex', id))).not.toBeNull()
    }

    // All previously retired accounts were evicted on switch.
    expect(readWslProviderUsage(wslProviderUsageKey('Debian', 'codex', 'acct-1'))).toBeNull()
    expect(readWslProviderUsage(wslProviderUsageKey('Debian', 'codex', 'acct-2'))).toBeNull()

    // Removing the distro owner evicts its remaining entries too.
    mocks.distro = null
    rerender()
    expect(readWslProviderUsage(wslProviderUsageKey('Debian', 'codex', 'acct-3'))).toBeNull()
    unmount()
  })
})
