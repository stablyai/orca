// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listNetworkInterfaces: vi.fn(),
  listRuntimeAccessGrants: vi.fn(),
  getRuntimePairingUrl: vi.fn(),
  updateSettings: vi.fn(),
  settings: null as null | {
    runtimePairingAdvertisedInterfaceName?: string | null
    runtimePairingAdvertisedAddress?: string | null
  }
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      settings: typeof mocks.settings
      updateSettings: typeof mocks.updateSettings
    }) => unknown
  ) => selector({ settings: mocks.settings, updateSettings: mocks.updateSettings })
}))
vi.mock('./RuntimeAccessGrantList', () => ({ RuntimeAccessGrantList: () => null }))
vi.mock('./RuntimePairingGeneratorForm', () => ({
  RuntimePairingGeneratorForm: (props: {
    selectedAddress: string
    onGenerate: () => void
    onSelectedAddressChange: (address: string) => void
    onRefreshNetworkInterfaces: () => void
  }) => (
    <div>
      <div data-testid="selected-address">{props.selectedAddress}</div>
      <button type="button" onClick={props.onGenerate}>
        Generate
      </button>
      <button type="button" onClick={() => props.onSelectedAddressChange('10.99.88.1')}>
        Pick bridge
      </button>
      <button type="button" onClick={props.onRefreshNetworkInterfaces}>
        Refresh
      </button>
    </div>
  )
}))

import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { runtimePairingLinkCache } from './runtime-pairing-link-state'

describe('RuntimePairingUrlGenerator', () => {
  beforeEach(() => {
    runtimePairingLinkCache.selectedAddress = '100.76.32.125'
    runtimePairingLinkCache.customAddress = ''
    runtimePairingLinkCache.intent = 'another'
    runtimePairingLinkCache.advertisedInterfaceName = null
    runtimePairingLinkCache.advertisedAddress = ''
    mocks.settings = null
    mocks.updateSettings.mockReset()
    runtimePairingLinkCache.generatedAddress = null
    runtimePairingLinkCache.runtimePairingUrl = null
    runtimePairingLinkCache.webClientUrl = null
    runtimePairingLinkCache.runtimePairingDeviceId = null
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
        platform: { get: () => ({ platform: 'darwin' as const }) },
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
  })

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

  // Why: the main process gates the one-way network widen on the declared reach, so dropping it (as the
  // component used to) leaves main guessing from the address string — "This computer only" then widened,
  // and a Custom loopback tunnel front-end would not.
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

  it('restores a saved Thunderbolt interface instead of Ethernet after restart', async () => {
    runtimePairingLinkCache.selectedAddress = ''
    mocks.settings = {
      runtimePairingAdvertisedInterfaceName: 'bridge0',
      runtimePairingAdvertisedAddress: '10.99.88.1'
    }
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [
        { name: 'en0', address: '192.168.4.191' },
        { name: 'bridge0', address: '10.99.88.1' }
      ]
    })

    render(<RuntimePairingUrlGenerator />)

    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('10.99.88.1')
    )
  })

  it('restores the saved address when discovery returns no interfaces', async () => {
    runtimePairingLinkCache.selectedAddress = ''
    mocks.settings = {
      runtimePairingAdvertisedInterfaceName: 'bridge0',
      runtimePairingAdvertisedAddress: '10.99.88.1'
    }
    mocks.listNetworkInterfaces.mockResolvedValue({ interfaces: [] })

    render(<RuntimePairingUrlGenerator />)

    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())
    expect(screen.getByTestId('selected-address')).toHaveTextContent('10.99.88.1')
  })

  it('remembers a new address on the saved interface', async () => {
    runtimePairingLinkCache.selectedAddress = ''
    mocks.settings = {
      runtimePairingAdvertisedInterfaceName: 'bridge0',
      runtimePairingAdvertisedAddress: '10.99.88.1'
    }
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [
        { name: 'en0', address: '192.168.4.191' },
        { name: 'bridge0', address: '10.99.88.2' }
      ]
    })

    render(<RuntimePairingUrlGenerator />)

    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('10.99.88.2')
    )
    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        runtimePairingAdvertisedInterfaceName: 'bridge0',
        runtimePairingAdvertisedAddress: '10.99.88.2'
      })
    )
  })

  it('keeps an explicit Thunderbolt pick when refresh reports only Ethernet', async () => {
    runtimePairingLinkCache.selectedAddress = ''
    mocks.listNetworkInterfaces
      .mockResolvedValueOnce({
        interfaces: [
          { name: 'en0', address: '192.168.4.191' },
          { name: 'bridge0', address: '10.99.88.1' }
        ]
      })
      .mockResolvedValueOnce({
        interfaces: [{ name: 'en0', address: '192.168.4.191' }]
      })

    render(<RuntimePairingUrlGenerator />)
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('192.168.4.191')
    )

    screen.getByRole('button', { name: 'Pick bridge' }).click()
    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        runtimePairingAdvertisedInterfaceName: 'bridge0',
        runtimePairingAdvertisedAddress: '10.99.88.1'
      })
    )

    screen.getByRole('button', { name: 'Refresh' }).click()
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('selected-address')).toHaveTextContent('10.99.88.1')
  })
})
