// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../../../../../shared/orca-profiles'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'

type MobileRelayStoreState = {
  orcaProfileAuthStatus: OrcaProfileAuthStatus | null
  connectCurrentOrcaProfile: () => Promise<null>
  fetchOrcaProfileAuthStatus: () => Promise<OrcaProfileAuthStatus | null>
  settings: { mobileIrohRelayUrl: string | null }
  updateSettingsOrThrow: (patch: { mobileIrohRelayUrl: string | null }) => Promise<void>
}

const mocks = vi.hoisted(() => {
  const state: MobileRelayStoreState = {
    orcaProfileAuthStatus: null,
    connectCurrentOrcaProfile: async () => null,
    fetchOrcaProfileAuthStatus: async () => null,
    settings: { mobileIrohRelayUrl: null },
    updateSettingsOrThrow: async () => undefined
  }
  return {
    state,
    listeners: new Set<() => void>(),
    useAppStore: (selector: (state: MobileRelayStoreState) => unknown) =>
      useSyncExternalStore(
        (onStoreChange) => {
          mocks.listeners.add(onStoreChange)
          return () => mocks.listeners.delete(onStoreChange)
        },
        () => selector(mocks.state)
      )
  }
})

// Use a subscribable mock so auth rereads reach the mounted tree rather than disappear into mutable selector state.
vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('@/store/index', () => ({ useAppStore: mocks.useAppStore }))

function publishStoreState(next: MobileRelayStoreState): void {
  mocks.state = next
  mocks.listeners.forEach((listener) => listener())
}

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('MobilePairingConnectionOptions Iroh', () => {
  const connect = vi.fn().mockResolvedValue(null)
  const fetchAuthStatus = vi.fn().mockResolvedValue(null)
  const getIrohStatus = vi.fn()
  const updateSettingsOrThrow = vi.fn()

  beforeEach(() => {
    connect.mockClear()
    fetchAuthStatus.mockClear()
    getIrohStatus.mockReset()
    getIrohStatus.mockResolvedValue({ bound: false, endpointId: null, relayUrl: null })
    updateSettingsOrThrow.mockReset().mockImplementation(async (patch) => {
      publishStoreState({ ...mocks.state, settings: { ...mocks.state.settings, ...patch } })
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getRelayStatus: vi.fn().mockResolvedValue({ status: 'registered' }),
          getIrohStatus,
          onRelayStatusChanged: vi.fn(() => vi.fn())
        },
        shell: { openUrl: vi.fn().mockResolvedValue(undefined) }
      }
    })
    mocks.state = {
      settings: { mobileIrohRelayUrl: null },
      updateSettingsOrThrow,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'local',
        persistence: 'none'
      },
      connectCurrentOrcaProfile: connect,
      fetchOrcaProfileAuthStatus: fetchAuthStatus
    }
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('keeps the home relay selector usable while Iroh is unavailable and reconciles external saves', async () => {
    getIrohStatus.mockResolvedValue({ bound: false, endpointId: null, relayUrl: null })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    const iroh = await screen.findByRole('radio', { name: /Iroh/i })
    expect(iroh).toHaveAttribute('aria-disabled', 'true')
    const selector = screen.getByRole('combobox', { name: 'Iroh home relay' })
    expect(selector).toBeEnabled()
    expect(screen.getByRole('radiogroup')).not.toContainElement(selector)

    await user.click(iroh)
    expect(onChange).not.toHaveBeenCalled()

    selector.focus()
    await user.keyboard('{ArrowDown}')
    await user.click(await screen.findByRole('option', { name: 'Europe' }))
    await waitFor(() =>
      expect(updateSettingsOrThrow).toHaveBeenCalledWith({
        mobileIrohRelayUrl: 'https://euc1-1.relay.n0.iroh.link./'
      })
    )
    expect(selector).toHaveTextContent('Europe')

    updateSettingsOrThrow.mockClear()
    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://other.example/' }
      })
    })
    expect(selector).toHaveTextContent('Custom HTTPS')
    expect(screen.getByRole('textbox', { name: 'Custom HTTPS relay origin' })).toHaveValue(
      'https://other.example/'
    )
    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://aps1-1.relay.n0.iroh.link./' }
      })
    })
    expect(selector).toHaveTextContent('Asia (Singapore)')
    expect(screen.queryByRole('textbox', { name: 'Custom HTTPS relay origin' })).toBeNull()
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('selects Custom by keyboard and saves only a valid HTTPS origin on Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    screen.getByRole('combobox', { name: 'Iroh home relay' }).focus()
    await user.keyboard('{ArrowDown}')
    await screen.findByRole('listbox')
    await user.keyboard('{End}{Enter}')
    const input = await screen.findByRole('textbox', { name: 'Custom HTTPS relay origin' })
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()

    for (const invalid of [
      'http://relay.example',
      'https://user:secret@relay.example',
      'https://relay.example/path',
      'https://relay.example?token=secret'
    ]) {
      await user.clear(input)
      await user.type(input, invalid)
      await user.click(screen.getByRole('button', { name: 'Save relay' }))
      expect(screen.getByRole('alert')).toBeVisible()
      expect(updateSettingsOrThrow).not.toHaveBeenCalled()
      expect(mocks.state.settings.mobileIrohRelayUrl).toBeNull()
    }

    await user.clear(input)
    await user.type(input, 'https://custom.example{Enter}')
    await waitFor(() =>
      expect(updateSettingsOrThrow).toHaveBeenCalledWith({
        mobileIrohRelayUrl: 'https://custom.example/'
      })
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the persisted preset after a rejected save and exposes a safe accessible error', async () => {
    mocks.state.settings.mobileIrohRelayUrl = 'https://euc1-1.relay.n0.iroh.link./'
    const save = Promise.withResolvers<void>()
    updateSettingsOrThrow.mockReturnValueOnce(save.promise)
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)
    const selector = screen.getByRole('combobox', { name: 'Iroh home relay' })

    selector.focus()
    await user.keyboard('{ArrowDown}')
    await user.click(await screen.findByRole('option', { name: 'US West' }))
    expect(selector).toBeDisabled()
    await act(async () => save.reject(new Error('private backend failure: secret-token')))

    const error = await screen.findByRole('alert')
    expect(error).toBeVisible()
    expect(error).not.toHaveTextContent('secret-token')
    expect(selector).toBeEnabled()
    expect(selector).toHaveTextContent('Europe')
    expect(mocks.state.settings.mobileIrohRelayUrl).toBe('https://euc1-1.relay.n0.iroh.link./')
  })

  it('resets Iroh availability on relay changes, ignores stale status and recovers on polling', async () => {
    vi.useFakeTimers()
    type IrohStatus = { bound: boolean; endpointId: string | null; relayUrl: string | null }
    const initial = Promise.withResolvers<IrohStatus>()
    getIrohStatus.mockReturnValueOnce(initial.promise)
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)
    await act(async () => {
      initial.resolve({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    })
    const iroh = screen.getByRole('radio', { name: /Iroh/i })
    expect(iroh).toHaveAttribute('aria-disabled', 'false')

    const stale = Promise.withResolvers<IrohStatus>()
    const current = Promise.withResolvers<IrohStatus>()
    getIrohStatus.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://euc1-1.relay.n0.iroh.link./' }
      })
    })
    expect(iroh).toHaveAttribute('aria-disabled', 'true')
    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://aps1-1.relay.n0.iroh.link./' }
      })
    })
    await act(async () => {
      stale.resolve({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    })
    expect(iroh).toHaveAttribute('aria-disabled', 'true')
    await act(async () => {
      current.resolve({ bound: false, endpointId: null, relayUrl: null })
    })
    getIrohStatus.mockResolvedValue({
      bound: true,
      endpointId: 'b'.repeat(64),
      relayUrl: 'https://actual-relay.example/'
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(iroh).toHaveAttribute('aria-disabled', 'false')
  })

  it('does not let an overlapping unbound response undo a successful Iroh bind', async () => {
    vi.useFakeTimers()
    type IrohStatus = { bound: boolean; endpointId: string | null; relayUrl: string | null }
    const status = Promise.withResolvers<IrohStatus>()
    const stale = Promise.withResolvers<IrohStatus>()
    getIrohStatus.mockReturnValue(stale.promise).mockReturnValueOnce(status.promise)
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    await act(async () => {
      status.resolve({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    })
    const iroh = screen.getByRole('radio', { name: /Iroh/i })
    expect(iroh).toHaveAttribute('aria-disabled', 'false')
    await act(async () => {
      stale.resolve({ bound: false, endpointId: null, relayUrl: null })
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(iroh).toHaveAttribute('aria-disabled', 'false')
  })

  it('navigates from the focused fallback when the selected Iroh path is unavailable', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="iroh" onChange={onChange} />)
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    expect(relay).toHaveAttribute('tabindex', '0')
    relay.focus()

    await user.keyboard('{ArrowDown}')

    expect(onChange).toHaveBeenCalledWith('local-only')
    expect(screen.getByRole('radio', { name: /^LAN\b/i })).toHaveFocus()
  })

  it('roves focus through all three paths and wraps in both directions', async () => {
    getIrohStatus.mockResolvedValue({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <MobilePairingConnectionOptions value="automatic" onChange={onChange} />
    )
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    const lan = screen.getByRole('radio', { name: /^LAN\b/i })
    const iroh = screen.getByRole('radio', { name: /Iroh/i })
    await waitFor(() => expect(iroh).toHaveAttribute('aria-disabled', 'false'))
    expect(relay).toHaveAttribute('tabindex', '0')
    expect(lan).toHaveAttribute('tabindex', '-1')
    expect(iroh).toHaveAttribute('tabindex', '-1')
    relay.focus()

    await user.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenLastCalledWith('local-only')
    expect(lan).toHaveFocus()
    rerender(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)
    expect(lan).toHaveAttribute('tabindex', '0')
    expect(relay).toHaveAttribute('tabindex', '-1')
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('iroh')
    expect(iroh).toHaveFocus()
    rerender(<MobilePairingConnectionOptions value="iroh" onChange={onChange} />)
    expect(iroh).toHaveAttribute('tabindex', '0')
    expect(lan).toHaveAttribute('tabindex', '-1')
    await user.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenLastCalledWith('automatic')
    expect(relay).toHaveFocus()
    rerender(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)
    await user.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('iroh')
    expect(iroh).toHaveFocus()

    screen.getByRole('button', { name: 'Sign in for Relay' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'Sign in for Relay' })).toHaveFocus()
    expect(relay).toHaveAttribute('aria-checked', 'true')
  })

  it('skips Relay in keyboard navigation while Relay is retrying', async () => {
    getIrohStatus.mockResolvedValue({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <MobilePairingConnectionOptions value="local-only" onChange={onChange} relayMintRetrying />
    )

    const iroh = screen.getByRole('radio', { name: /Iroh/i })
    await waitFor(() => expect(iroh).toHaveAttribute('aria-disabled', 'false'))
    screen.getByRole('radio', { name: /^LAN\b/i }).focus()
    await user.keyboard('{ArrowUp}')
    expect(onChange).toHaveBeenCalledWith('iroh')
  })
})
