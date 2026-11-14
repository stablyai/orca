// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPairedMobileDevicesCacheForTests,
  type PairedMobileDevice as PairedDevice
} from '../../mobile/paired-mobile-devices'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

type PairedDevicesProps = {
  devices: readonly PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
}

type StoreState = {
  orcaProfileAuthStatus: { state: 'connected' | 'local' }
  settingsSearchQuery: string
  settings: {
    mobileAutoRestoreFitMs: number | null
    mobilePairingConnectionMode?: MobilePairingConnectionMode
    mobilePairingCustomAddress?: string | null
    mobilePairingCustomAddresses?: string[]
  }
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  recordFeatureInteraction: (feature: string) => void
  fetchOrcaProfileAuthStatus: () => Promise<unknown>
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: {} as StoreState }
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return {
    holder,
    useAppStore,
    latestPairedDevicesProps: null as PairedDevicesProps | null,
    getPairingQR: vi.fn(),
    listDevices: vi.fn(),
    listNetworkInterfaces: vi.fn(),
    revokeDevice: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    updateSettings: vi.fn()
  }
})

vi.mock('@/store/index', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../../store/index', () => ({ useAppStore: mocks.useAppStore }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))
vi.mock('../../mobile/pairing/mobile-pairing-device-polling', () => ({
  useMobilePairingDevicePolling: vi.fn()
}))

// Stub sections to isolate MobilePane’s mode safety, generation gate and persistence.
vi.mock('./pairing/MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: (props: {
    connectionMode: MobilePairingConnectionMode
    canGenerate?: boolean
    loading: boolean
    connectionPathControl: React.ReactNode
    networkInterfaces: { name: string; address: string }[]
    customAddresses: readonly string[]
    selectedAddress: string | undefined
    selectedAddressIsCustom: boolean
    onSelectedAddressChange: (address: string) => void
    onCustomAddressSelect: (address: string) => void
    onCustomAddressRemove: (address: string) => void
    refreshingNetworkInterfaces: boolean
    onRefreshNetworkInterfaces: () => void
    onGenerateQr: () => void
  }) => (
    <div>
      <span data-testid="mode">{props.connectionMode}</span>
      <span data-testid="can-generate">{String(props.canGenerate)}</span>
      <span data-testid="loading">{String(props.loading)}</span>
      <span data-testid="selected-address">{props.selectedAddress ?? 'none'}</span>
      <span data-testid="selected-address-is-custom">{String(props.selectedAddressIsCustom)}</span>
      <span data-testid="custom-addresses">{props.customAddresses.join(',')}</span>
      <span data-testid="refreshing-addresses">{String(props.refreshingNetworkInterfaces)}</span>
      {props.connectionPathControl}
      {/* Mirror real generation gating so wedged loading state remains observable. */}
      <button
        type="button"
        onClick={props.onGenerateQr}
        disabled={props.loading || props.canGenerate === false}
      >
        Generate
      </button>
      <button type="button" onClick={() => props.onCustomAddressSelect('100.126.117.25:6768')}>
        choose-custom-address
      </button>
      <button type="button" onClick={() => props.onCustomAddressRemove('100.126.117.25:6768')}>
        remove-custom-address
      </button>
      <button
        type="button"
        disabled={props.networkInterfaces.length === 0}
        onClick={() => props.onSelectedAddressChange(props.networkInterfaces[0]!.address)}
      >
        choose-discovered-address
      </button>
      <button type="button" onClick={props.onRefreshNetworkInterfaces}>
        refresh-addresses
      </button>
    </div>
  )
}))
vi.mock('../../mobile/pairing/MobilePairingConnectionOptions', () => ({
  MobilePairingConnectionOptions: (props: {
    onChange: (mode: MobilePairingConnectionMode) => void
  }) => (
    <div>
      <button type="button" onClick={() => props.onChange('automatic')}>
        choose-anywhere
      </button>
      <button type="button" onClick={() => props.onChange('local-only')}>
        choose-local
      </button>
    </div>
  )
}))
vi.mock('./pairing/MobilePairingQrSection', () => ({
  MobilePairingQrSection: (props: {
    qrDataUrl: string | null
    pairingUrl: string | null
    qrError: boolean
  }) => (
    <div>
      <span data-testid="qr">{props.qrDataUrl ?? 'none'}</span>
      <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
      <span data-testid="qr-error">{String(props.qrError)}</span>
    </div>
  )
}))
vi.mock('./pairing/MobilePairedDevicesSection', () => ({
  MobilePairedDevicesSection: (props: PairedDevicesProps) => {
    mocks.latestPairedDevicesProps = props
    return <div data-testid="paired-devices">{props.devices.map((d) => d.deviceId).join(',')}</div>
  }
}))
vi.mock('./MobileAutoRestoreFitSection', () => ({ MobileAutoRestoreFitSection: () => <div /> }))
vi.mock('../../mobile/WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: (props: { usingRelay?: boolean }) => (
    <div data-testid="firewall-notice">{String(props.usingRelay)}</div>
  )
}))

import { MobilePane } from './MobilePane'

describe('MobilePane pairing connection mode', () => {
  const getPairingQR = mocks.getPairingQR
  const updateSettings = mocks.updateSettings

  beforeEach(() => {
    vi.clearAllMocks()
    _resetPairedMobileDevicesCacheForTests()
    mocks.latestPairedDevicesProps = null
    getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair',
      endpoint: 'ws://host',
      connectionMode: 'automatic'
    })
    mocks.listDevices.mockReset().mockResolvedValue({ devices: [] })
    mocks.listNetworkInterfaces.mockReset().mockResolvedValue({ interfaces: [] })
    mocks.revokeDevice.mockReset().mockResolvedValue({ revoked: true })
    updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.holder.state = {
      orcaProfileAuthStatus: { state: 'connected' },
      settingsSearchQuery: '',
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings,
      recordFeatureInteraction: vi.fn(),
      fetchOrcaProfileAuthStatus: vi.fn().mockResolvedValue(null)
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: mocks.listDevices,
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        },
        ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
      }
    })
  })

  afterEach(() => {
    cleanup()
    _resetPairedMobileDevicesCacheForTests()
    document.body.innerHTML = ''
  })

  it('drops loading after switching path mid-generate', async () => {
    const user = userEvent.setup()
    getPairingQR.mockImplementationOnce(() => new Promise(() => {}))
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))
    expect(screen.getByTestId('loading')).toHaveTextContent('true')

    // Switching modes must clear the old mint’s loading flag so the new path can generate.
    await user.click(screen.getByRole('button', { name: 'choose-local' }))
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
  })

  it('clears a shown QR when another window changes the saved path', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr'))

    // Model cross-window persistence bypassing changeConnectionMode.
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingConnectionMode: 'local-only'
    }
    rerender(<MobilePane />)

    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('local-only'))
    expect(screen.getByTestId('qr')).toHaveTextContent('none')
  })
})
