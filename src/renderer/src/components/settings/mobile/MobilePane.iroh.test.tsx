// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, useSyncExternalStore } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import { _resetPairedMobileDevicesCacheForTests } from '../../mobile/paired-mobile-devices'

type StoreState = {
  orcaProfileAuthStatus: { state: 'connected' | 'local' }
  settingsSearchQuery: string
  settings: {
    mobileAutoRestoreFitMs: number | null
    mobilePairingConnectionMode?: MobilePairingConnectionMode
    mobilePairingCustomAddress?: string | null
    mobileIrohRelayUrl?: string | null
  }
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  updateSettingsOrThrow: (patch: Record<string, unknown>) => Promise<void>
  recordFeatureInteraction: (feature: string) => void
  fetchOrcaProfileAuthStatus: () => Promise<unknown>
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: {} as StoreState }
  const listeners = new Set<() => void>()
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        () => selector(holder.state)
      ),
    { getState: () => holder.state }
  )
  return {
    holder,
    listeners,
    useAppStore,
    getPairingQR: vi.fn(),
    listNetworkInterfaces: vi.fn(),
    revokeDevice: vi.fn(),
    updateSettings: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../../store/index', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./pairing/mobile-pairing-device-polling', () => ({
  useMobilePairingDevicePolling: vi.fn()
}))
vi.mock('./pairing/MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: (props: {
    canGenerate?: boolean
    loading: boolean
    connectionPathControl: React.ReactNode
    selectedAddress: string | undefined
    showGenerateAction?: boolean
    onGenerateQr: () => void
  }) => (
    <div>
      <span data-testid="can-generate">{String(props.canGenerate)}</span>
      <span data-testid="selected-address">{props.selectedAddress ?? 'none'}</span>
      {props.connectionPathControl}
      {props.showGenerateAction !== false ? (
        <button
          type="button"
          onClick={props.onGenerateQr}
          disabled={props.loading || props.canGenerate === false}
        >
          Generate
        </button>
      ) : null}
    </div>
  )
}))
vi.mock('./pairing/MobilePairingConnectionOptions', () => ({
  MobilePairingConnectionOptions: (props: {
    onChange: (mode: MobilePairingConnectionMode) => void
  }) => (
    <button type="button" onClick={() => props.onChange('iroh')}>
      choose-iroh
    </button>
  )
}))
vi.mock('./pairing/MobilePairingQrSection', () => ({
  MobilePairingQrSection: (props: { qrDataUrl: string | null; pairingUrl: string | null }) => (
    <div>
      <span data-testid="qr">{props.qrDataUrl ?? 'none'}</span>
      <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
    </div>
  )
}))
vi.mock('./pairing/MobilePairedDevicesSection', () => ({
  MobilePairedDevicesSection: () => <div />
}))
vi.mock('./MobileAutoRestoreFitSection', () => ({ MobileAutoRestoreFitSection: () => <div /> }))
vi.mock('../../mobile/WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: (props: { pairingReady: boolean }) => (
    <div data-testid="firewall-notice" data-pairing-ready={String(props.pairingReady)} />
  )
}))
vi.mock('../../machine-identity/MachineNameField', () => ({ MachineNameField: () => null }))

import { MobilePane } from './MobilePane'

function publishStoreState(next: StoreState): void {
  mocks.holder.state = next
  mocks.listeners.forEach((listener) => listener())
}

describe('MobilePane Iroh pairing', () => {
  const getPairingQR = mocks.getPairingQR
  const updateSettings = mocks.updateSettings

  beforeEach(() => {
    vi.clearAllMocks()
    _resetPairedMobileDevicesCacheForTests()
    getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair',
      endpoint: 'ws://host',
      connectionMode: 'automatic'
    })
    mocks.listNetworkInterfaces.mockReset().mockResolvedValue({ interfaces: [] })
    mocks.revokeDevice.mockReset().mockResolvedValue({ revoked: true })
    updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.holder.state = {
      orcaProfileAuthStatus: { state: 'connected' },
      settingsSearchQuery: '',
      settings: { mobileAutoRestoreFitMs: null, mobileIrohRelayUrl: null },
      updateSettings,
      updateSettingsOrThrow: vi.fn().mockResolvedValue(undefined),
      recordFeatureInteraction: vi.fn(),
      fetchOrcaProfileAuthStatus: vi.fn().mockResolvedValue(null)
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: vi.fn().mockResolvedValue({ devices: [] }),
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

  it('pairs through Iroh without sign-in, a LAN address, or TCP firewall repair', async () => {
    mocks.holder.state.orcaProfileAuthStatus = { state: 'local' }
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'Ethernet', address: '10.0.0.2' }]
    })
    getPairingQR.mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,iroh',
      pairingUrl: 'orca://pair#iroh',
      endpoint: 'iroh://endpoint-id',
      connectionMode: 'iroh'
    })
    const user = userEvent.setup()
    render(<MobilePane />)
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('10.0.0.2')
    )

    await user.click(screen.getByRole('button', { name: 'choose-iroh' }))
    expect(screen.getByTestId('can-generate')).toHaveTextContent('true')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'iroh' }))
    expect(screen.getByTestId('qr')).toHaveTextContent('base64,iroh')
    expect(screen.getByTestId('firewall-notice')).toHaveAttribute('data-pairing-ready', 'false')
  })

  it('keeps Generate available when another pairing surface supersedes the current Iroh request', async () => {
    mocks.holder.state.settings.mobilePairingConnectionMode = 'iroh'
    const pending = Promise.withResolvers<Record<string, unknown>>()
    getPairingQR
      .mockResolvedValue({
        available: true,
        qrDataUrl: 'data:image/png;base64,iroh',
        pairingUrl: 'orca://pair#iroh',
        endpoint: 'iroh://endpoint-id',
        connectionMode: 'iroh'
      })
      .mockReturnValueOnce(pending.promise)
    const user = userEvent.setup()
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()

    // Cross-surface supersession leaves this pane's local request ID current.
    await act(async () =>
      pending.resolve({
        available: false,
        reason: 'relay_mint_failed',
        guidance: 'The Relay pairing request was replaced by a newer connection choice.',
        relayFailure: {
          code: 'relay_request_superseded',
          stage: 'binding_failed',
          message: 'Relay pairing request superseded'
        }
      })
    )
    expect(screen.getByTestId('pairing-url')).toHaveTextContent(/^none$/)
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() =>
      expect(screen.getByTestId('pairing-url')).toHaveTextContent('orca://pair#iroh')
    )
    expect(screen.getByTestId('qr')).toHaveTextContent('base64,iroh')
  })

  it.each(['displayed', 'pending'])(
    'keeps a %s Iroh offer when another window changes its LAN preference',
    async (priorState) => {
      mocks.holder.state.settings.mobilePairingConnectionMode = 'iroh'
      const offer = Promise.withResolvers<Record<string, unknown>>()
      getPairingQR.mockReturnValueOnce(offer.promise)
      const user = userEvent.setup()
      render(<MobilePane />)
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      const result = {
        available: true,
        qrDataUrl: 'data:image/png;base64,iroh',
        pairingUrl: 'orca://pair#iroh',
        connectionMode: 'iroh'
      }
      if (priorState === 'displayed') {
        await act(async () => offer.resolve(result))
      }

      act(() => {
        publishStoreState({
          ...mocks.holder.state,
          settings: {
            ...mocks.holder.state.settings,
            mobilePairingCustomAddress: '100.64.0.3:6768'
          }
        })
      })
      if (priorState === 'pending') {
        await act(async () => offer.resolve(result))
      }

      await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('base64,iroh'))
      expect(screen.getByTestId('pairing-url')).toHaveTextContent('orca://pair#iroh')
      expect(getPairingQR).toHaveBeenCalledOnce()
      expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
    }
  )

  it.each(['displayed', 'copy-only', 'pending'])(
    'refreshes a %s Iroh offer after an external relay change without rotation or revocation',
    async (priorState) => {
      mocks.holder.state.settings = {
        mobileAutoRestoreFitMs: null,
        mobilePairingConnectionMode: 'iroh',
        mobileIrohRelayUrl: null,
        mobilePairingCustomAddress: '100.126.117.25:6768'
      }
      const previous = Promise.withResolvers<Record<string, unknown>>()
      const current = Promise.withResolvers<Record<string, unknown>>()
      const previousOffer = {
        available: true,
        qrDataUrl: priorState === 'copy-only' ? null : 'data:image/png;base64,old-relay',
        pairingUrl: 'orca://pair#old-relay',
        endpoint: 'iroh://endpoint-id',
        connectionMode: 'iroh'
      }
      getPairingQR.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
      const user = userEvent.setup()
      render(<MobilePane />)
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      await waitFor(() => expect(getPairingQR).toHaveBeenCalledOnce())
      if (priorState !== 'pending') {
        previous.resolve(previousOffer)
        await waitFor(() =>
          expect(screen.getByTestId('pairing-url')).toHaveTextContent('orca://pair#old-relay')
        )
      }

      act(() => {
        publishStoreState({
          ...mocks.holder.state,
          settings: {
            ...mocks.holder.state.settings,
            mobileIrohRelayUrl: 'https://aps1-1.relay.n0.iroh.link./'
          }
        })
      })
      expect(screen.getByTestId('qr')).toHaveTextContent('none')
      expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
      await waitFor(() => expect(getPairingQR).toHaveBeenCalledTimes(2))
      if (priorState === 'pending') {
        await act(async () => previous.resolve(previousOffer))
      }
      expect(screen.getByTestId('qr')).toHaveTextContent('none')
      expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
      expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()

      current.resolve({
        available: true,
        qrDataUrl: 'data:image/png;base64,current-relay',
        pairingUrl: 'orca://pair#actual-backend-relay',
        endpoint: 'iroh://endpoint-id',
        connectionMode: 'iroh'
      })
      await waitFor(() =>
        expect(screen.getByTestId('qr')).toHaveTextContent('base64,current-relay')
      )
      expect(screen.getByTestId('pairing-url')).toHaveTextContent(
        'orca://pair#actual-backend-relay'
      )
      expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
      expect(getPairingQR.mock.calls).toEqual([
        [{ connectionMode: 'iroh' }],
        [{ connectionMode: 'iroh' }]
      ])
      expect(mocks.revokeDevice).not.toHaveBeenCalled()
      expect(updateSettings).not.toHaveBeenCalled()
    }
  )
})
