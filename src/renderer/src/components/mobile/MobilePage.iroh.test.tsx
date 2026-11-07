// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobilePairingConnectionMode } from '../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

type StoreState = {
  closeMobilePage: () => void
  orcaProfileAuthStatus: { state: 'connected' | 'local' }
  settings: {
    showMobileButton: boolean
    mobilePairingConnectionMode?: MobilePairingConnectionMode
    mobilePairingCustomAddress?: string | null
    mobileIrohRelayUrl?: string | null
  }
  updateSettings: () => Promise<void>
  updateSettingsOrThrow: (patch: Record<string, unknown>) => Promise<void>
  fetchOrcaProfileAuthStatus: () => Promise<unknown>
}

const mocks = vi.hoisted(() => ({
  storeState: {} as StoreState,
  listeners: new Set<() => void>(),
  revokeDevice: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) =>
    useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener)
        return () => mocks.listeners.delete(listener)
      },
      () => selector(mocks.storeState)
    )
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() } }))
vi.mock('./use-mobile-install-qr', () => ({ useMobileInstallQr: () => null }))
vi.mock('./use-mobile-page-escape', () => ({ useMobilePageEscape: vi.fn() }))
vi.mock('../settings/mobile/pairing/mobile-pairing-device-polling', () => ({
  useMobilePairingDevicePolling: vi.fn()
}))
vi.mock('./MobilePageContent', () => ({
  MobilePageContent: (props: {
    canGeneratePairing: boolean
    enterFlow: () => void
    handleConnectionModeChange: (mode: MobilePairingConnectionMode) => void
    handleAddressChange: (address: string) => void
    handleContinue: () => void
    handleBack: () => void
    pairLoading: boolean
    pairQrDataUrl: string | null
    pairingUrl: string | null
    selectedAddress: string | undefined
    refreshingNetworkInterfaces: boolean
    stage: string | null
  }) => (
    <div>
      <span data-testid="stage">{props.stage ?? 'loading'}</span>
      <span data-testid="can-generate">{String(props.canGeneratePairing)}</span>
      <span data-testid="pair-loading">{String(props.pairLoading)}</span>
      <span data-testid="pairing-qr">{props.pairQrDataUrl ?? 'none'}</span>
      <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
      <span data-testid="selected-address">{props.selectedAddress ?? 'none'}</span>
      <span data-testid="refreshing-addresses">{String(props.refreshingNetworkInterfaces)}</span>
      <button type="button" onClick={props.enterFlow}>
        Enter flow
      </button>
      <button type="button" onClick={props.handleContinue}>
        Continue
      </button>
      <button type="button" onClick={props.handleBack}>
        Back
      </button>
      <button type="button" onClick={() => props.handleConnectionModeChange('local-only')}>
        LAN
      </button>
      <button type="button" onClick={() => props.handleConnectionModeChange('iroh')}>
        Iroh
      </button>
      <button type="button" onClick={() => props.handleAddressChange('10.0.0.2')}>
        Change address
      </button>
    </div>
  )
}))

import MobilePage from './MobilePage'
import { _resetPairedMobileDevicesCacheForTests } from './paired-mobile-devices'

function publishStoreState(next: StoreState): void {
  mocks.storeState = next
  mocks.listeners.forEach((listener) => listener())
}

describe('MobilePage Iroh pairing', () => {
  const getPairingQR = vi.fn()
  const listNetworkInterfaces = vi.fn()

  beforeEach(() => {
    getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      qrSize: 218,
      pairingUrl: 'orca://pair#automatic'
    })
    listNetworkInterfaces.mockReset().mockResolvedValue({ interfaces: [] })
    mocks.revokeDevice.mockReset().mockResolvedValue({ revoked: true })
    _resetPairedMobileDevicesCacheForTests()
    mocks.storeState = {
      closeMobilePage: vi.fn(),
      orcaProfileAuthStatus: { state: 'connected' },
      settings: { showMobileButton: true, mobileIrohRelayUrl: null },
      updateSettings: vi.fn().mockResolvedValue(undefined),
      updateSettingsOrThrow: vi.fn().mockResolvedValue(undefined),
      fetchOrcaProfileAuthStatus: vi.fn().mockResolvedValue(null)
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: vi.fn().mockResolvedValue({ devices: [] }),
          listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        },
        shell: { openUrl: vi.fn() },
        ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
      }
    })
  })

  afterEach(cleanup)

  async function openPairingStep(): Promise<void> {
    const user = userEvent.setup()
    render(<MobilePage />)
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('intro'))
    await user.click(screen.getByRole('button', { name: 'Enter flow' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
  }

  it('mints Iroh without waiting for LAN discovery and ignores unrelated address changes', async () => {
    mocks.storeState.settings.mobilePairingConnectionMode = 'iroh'
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    getPairingQR.mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair#iroh',
      connectionMode: 'iroh'
    })
    const lookup = Promise.withResolvers<Record<string, unknown>>()
    listNetworkInterfaces.mockReturnValueOnce(lookup.promise)
    await openPairingStep()

    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'iroh' }))
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))
    expect(screen.getByTestId('pair-loading')).toHaveTextContent('false')
    expect(screen.getByTestId('refreshing-addresses')).toHaveTextContent('true')

    act(() => {
      mocks.storeState = {
        ...mocks.storeState,
        settings: { ...mocks.storeState.settings, mobilePairingCustomAddress: '100.64.0.3:6768' }
      }
      mocks.listeners.forEach((listener) => listener())
    })
    await act(async () => {
      lookup.resolve({ interfaces: [{ name: 'Wi-Fi', address: '10.0.0.5' }] })
    })
    expect(getPairingQR).toHaveBeenCalledOnce()
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr')
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('orca://pair#iroh')
  })

  it('waits for the current LAN address when leaving Iroh during a new visit lookup', async () => {
    const user = userEvent.setup()
    mocks.storeState.settings.mobilePairingConnectionMode = 'iroh'
    const lookup = Promise.withResolvers<Record<string, unknown>>()
    listNetworkInterfaces
      .mockResolvedValueOnce({ interfaces: [{ name: 'Wi-Fi', address: '10.0.0.5' }] })
      .mockReturnValueOnce(lookup.promise)
    getPairingQR.mockImplementation(
      ({
        connectionMode,
        address
      }: {
        connectionMode: MobilePairingConnectionMode
        address?: string
      }) =>
        Promise.resolve(
          connectionMode === 'iroh'
            ? {
                available: true,
                qrDataUrl: 'data:image/png;base64,iroh',
                pairingUrl: 'orca://pair#iroh'
              }
            : address === '10.0.0.9'
              ? {
                  available: true,
                  qrDataUrl: 'data:image/png;base64,current-lan',
                  pairingUrl: 'orca://pair#10.0.0.9'
                }
              : {
                  available: true,
                  qrDataUrl: 'data:image/png;base64,stale-lan',
                  pairingUrl: 'orca://pair#10.0.0.5'
                }
        )
    )
    await openPairingStep()
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('10.0.0.5')
    )
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Enter flow' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,iroh'))
    expect(screen.getByTestId('refreshing-addresses')).toHaveTextContent('true')

    await user.click(screen.getByRole('button', { name: 'LAN' }))
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
    expect(screen.getByTestId('pair-loading')).toHaveTextContent('true')
    expect(getPairingQR).not.toHaveBeenCalledWith({
      address: '10.0.0.5',
      connectionMode: 'local-only'
    })

    await act(async () => {
      lookup.resolve({ interfaces: [{ name: 'Wi-Fi', address: '10.0.0.9' }] })
    })
    await waitFor(() =>
      expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,current-lan')
    )
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('orca://pair#10.0.0.9')
    expect(screen.getByTestId('pair-loading')).toHaveTextContent('false')
  })

  it('omits saved and overridden addresses from signed-out Iroh requests without losing LAN selection', async () => {
    const user = userEvent.setup()
    const address = '100.126.117.25:6768'
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    mocks.storeState.settings = {
      showMobileButton: true,
      mobilePairingConnectionMode: 'iroh',
      mobilePairingCustomAddress: address
    }
    await openPairingStep()

    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'iroh' }))
    expect(screen.getByTestId('selected-address')).toHaveTextContent(address)
    expect(screen.getByTestId('can-generate')).toHaveTextContent('true')
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))

    await user.click(screen.getByRole('button', { name: 'LAN' }))
    await waitFor(() =>
      expect(getPairingQR).toHaveBeenLastCalledWith({ address, connectionMode: 'local-only' })
    )
    await user.click(screen.getByRole('button', { name: 'Iroh' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenLastCalledWith({ connectionMode: 'iroh' }))

    getPairingQR.mockClear()
    await user.click(screen.getByRole('button', { name: 'Change address' }))
    expect(screen.getByTestId('selected-address')).toHaveTextContent('10.0.0.2')
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr')
  })

  it.each(['displayed', 'pending'])(
    'refreshes a %s Iroh QR after an external relay change without rotation or revocation',
    async (priorState) => {
      mocks.storeState.settings = {
        showMobileButton: true,
        mobilePairingConnectionMode: 'iroh',
        mobileIrohRelayUrl: null,
        mobilePairingCustomAddress: '100.126.117.25:6768'
      }
      const previous = Promise.withResolvers<Record<string, unknown>>()
      const current = Promise.withResolvers<Record<string, unknown>>()
      const previousOffer = {
        available: true,
        qrDataUrl: 'data:image/png;base64,old-relay',
        pairingUrl: 'orca://pair#old-relay'
      }
      getPairingQR.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
      await openPairingStep()
      await waitFor(() => expect(getPairingQR).toHaveBeenCalledOnce())
      if (priorState === 'displayed') {
        previous.resolve(previousOffer)
        await waitFor(() =>
          expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,old-relay')
        )
      }

      act(() => {
        publishStoreState({
          ...mocks.storeState,
          settings: {
            ...mocks.storeState.settings,
            mobileIrohRelayUrl: 'https://aps1-1.relay.n0.iroh.link./'
          }
        })
      })
      expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
      expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
      await waitFor(() => expect(getPairingQR).toHaveBeenCalledTimes(2))
      if (priorState === 'pending') {
        await act(async () => previous.resolve(previousOffer))
      }
      expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
      expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
      expect(screen.getByTestId('pair-loading')).toHaveTextContent('true')

      current.resolve({
        available: true,
        qrDataUrl: 'data:image/png;base64,current-relay',
        pairingUrl: 'orca://pair#actual-backend-relay'
      })
      await waitFor(() =>
        expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,current-relay')
      )
      expect(screen.getByTestId('pairing-url')).toHaveTextContent(
        'orca://pair#actual-backend-relay'
      )
      expect(screen.getByTestId('pair-loading')).toHaveTextContent('false')
      expect(getPairingQR.mock.calls).toEqual([
        [{ connectionMode: 'iroh' }],
        [{ connectionMode: 'iroh' }]
      ])
      expect(mocks.revokeDevice).not.toHaveBeenCalled()
      expect(mocks.storeState.updateSettings).not.toHaveBeenCalled()
    }
  )
})
