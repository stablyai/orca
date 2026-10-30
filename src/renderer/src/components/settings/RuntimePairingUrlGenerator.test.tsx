// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listNetworkInterfaces: vi.fn(),
  listRuntimeAccessGrants: vi.fn(),
  getRuntimePairingUrl: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./RuntimeAccessGrantList', () => ({ RuntimeAccessGrantList: () => null }))
vi.mock('./RuntimePairingGeneratorForm', () => ({
  RuntimePairingGeneratorForm: (props: {
    selectedAddress: string
    onGenerate: () => void
    onIntentChange: (intent: 'relay') => void
    runtimePairingUrl: string | null
  }) => (
    <div>
      <div data-testid="selected-address">{props.selectedAddress}</div>
      <div>{props.runtimePairingUrl}</div>
      <button type="button" onClick={() => props.onIntentChange('relay')}>
        Relay
      </button>
      <button type="button" onClick={props.onGenerate}>
        Generate
      </button>
    </div>
  )
}))

import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { createMobileRelayPairingFixtures } from '../../../../shared/mobile-relay-pairing-fixtures'
import { encodePairingOffer } from '../../../../shared/pairing'
import { runtimePairingLinkCache } from './runtime-pairing-link-state'

describe('RuntimePairingUrlGenerator', () => {
  beforeEach(() => {
    runtimePairingLinkCache.selectedAddress = '100.76.32.125'
    runtimePairingLinkCache.customAddress = ''
    runtimePairingLinkCache.intent = 'another'
    runtimePairingLinkCache.generatedAddress = null
    runtimePairingLinkCache.runtimePairingUrl = null
    runtimePairingLinkCache.webClientUrl = null
    runtimePairingLinkCache.runtimePairingDeviceId = null
    runtimePairingLinkCache.inviteExpiresAt = null
    mocks.listNetworkInterfaces.mockReset()
    mocks.listRuntimeAccessGrants.mockReset().mockResolvedValue({ grants: [] })
    mocks.getRuntimePairingUrl.mockReset().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: 'http://127.0.0.1:6768/web-index.html?pairing=runtime',
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'runtime-1'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          listRuntimeAccessGrants: mocks.listRuntimeAccessGrants,
          getRuntimePairingUrl: mocks.getRuntimePairingUrl
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each([false, true])(
    'hides expired Relay codes, including after reopening (reopen: %s)',
    async (reopen) => {
      vi.useFakeTimers()
      const offer = createMobileRelayPairingFixtures(Date.now()).find(
        (fixture) => fixture.name === 'relay offer with runtime scope'
      )?.expected
      if (!offer?.relay) {
        throw new Error('Expected a Relay fixture')
      }
      const pairingUrl = encodePairingOffer(offer)
      runtimePairingLinkCache.intent = 'relay'
      runtimePairingLinkCache.selectedAddress = '127.0.0.1'
      mocks.listNetworkInterfaces.mockResolvedValue({ interfaces: [] })
      mocks.getRuntimePairingUrl.mockResolvedValue({
        available: true,
        pairingUrl,
        webClientUrl: null,
        deviceId: 'runtime-1'
      })
      const view = render(<RuntimePairingUrlGenerator />)
      await act(async () => screen.getByRole('button', { name: 'Generate' }).click())
      expect(screen.getByText(pairingUrl)).toBeInTheDocument()
      if (reopen) {
        view.unmount()
      }
      act(() => vi.advanceTimersByTime(offer.relay.inviteExpiresAt - Date.now()))
      if (reopen) {
        render(<RuntimePairingUrlGenerator />)
      }
      expect(screen.queryByText(pairingUrl)).toBeNull()
      expect(runtimePairingLinkCache.runtimePairingUrl).toBeNull()
      expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument()
    }
  )

  it('keeps the cached address while interfaces are loading', async () => {
    let resolveInterfaces!: (value: { interfaces: { name: string; address: string }[] }) => void
    mocks.listNetworkInterfaces.mockReturnValue(
      new Promise((resolve) => {
        resolveInterfaces = resolve
      })
    )

    render(<RuntimePairingUrlGenerator />)
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())
    expect(screen.getByTestId('selected-address')).toHaveTextContent('100.76.32.125')

    resolveInterfaces({
      interfaces: [{ name: 'tailscale0', address: '100.76.32.125' }]
    })
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('100.76.32.125')
    )
  })

  // Declared reach gates network widening; address strings alone confuse local-only intent with custom loopback tunnels.
  it.each([
    ['local' as const, '127.0.0.1', 'this-computer'],
    ['another' as const, '100.76.32.125', 'network'],
    ['custom' as const, '127.0.0.1:8443', 'network']
  ])('sends the %s reach with the address', async (intent, address, reach) => {
    runtimePairingLinkCache.intent = intent
    runtimePairingLinkCache.selectedAddress = address
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'tailscale0', address: '100.76.32.125' }]
    })

    render(<RuntimePairingUrlGenerator />)
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())

    screen.getByRole('button', { name: 'Generate' }).click()

    await waitFor(() =>
      expect(mocks.getRuntimePairingUrl).toHaveBeenCalledWith({ address, rotate: true, reach })
    )
  })
  it('requests a Relay access code without depending on a LAN interface', async () => {
    runtimePairingLinkCache.intent = 'relay'
    runtimePairingLinkCache.selectedAddress = '127.0.0.1'
    mocks.listNetworkInterfaces.mockResolvedValue({ interfaces: [] })
    render(<RuntimePairingUrlGenerator />)
    screen.getByRole('button', { name: 'Generate' }).click()
    await waitFor(() =>
      expect(mocks.getRuntimePairingUrl).toHaveBeenCalledWith({
        address: '127.0.0.1',
        rotate: true,
        reach: 'network',
        connectionMode: 'relay'
      })
    )
  })
  it('does not reuse a local code when switching to Relay at the same address', async () => {
    runtimePairingLinkCache.intent = 'local'
    runtimePairingLinkCache.selectedAddress = '127.0.0.1'
    runtimePairingLinkCache.generatedAddress = '127.0.0.1'
    runtimePairingLinkCache.runtimePairingUrl = 'local-only-link'
    mocks.listNetworkInterfaces.mockResolvedValue({ interfaces: [] })
    render(<RuntimePairingUrlGenerator />)
    expect(screen.getByText('local-only-link')).not.toBeNull()
    screen.getByRole('button', { name: 'Relay' }).click()
    await waitFor(() => expect(screen.queryByText('local-only-link')).toBeNull())
    expect(runtimePairingLinkCache.runtimePairingUrl).toBeNull()
  })
})
