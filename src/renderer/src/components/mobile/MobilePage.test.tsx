// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

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
    mobilePairingCustomAddresses?: string[]
  }
  updateSettings: () => Promise<void>
  fetchOrcaProfileAuthStatus: () => Promise<unknown>
}

const mocks = vi.hoisted(() => ({
  storeState: {} as StoreState
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() }
}))

vi.mock('./use-mobile-install-qr', () => ({ useMobileInstallQr: () => null }))
vi.mock('./use-mobile-page-escape', () => ({ useMobilePageEscape: vi.fn() }))
vi.mock('../settings/mobile/pairing/mobile-pairing-device-polling', () => ({
  useMobilePairingDevicePolling: vi.fn()
}))

vi.mock('./MobilePageContent', () => ({
  MobilePageContent: (props: {
    stage: string | null
    pairLoading: boolean
    pairQrDataUrl: string | null
    selectedAddress: string | undefined
    enterFlow: () => void
    handleContinue: () => void
    handleBack: () => void
    loadNetworkInterfaces: () => void
  }) => (
    <div>
      <span data-testid="stage">{props.stage ?? 'loading'}</span>
      <span data-testid="pair-loading">{String(props.pairLoading)}</span>
      <span data-testid="pairing-qr">{props.pairQrDataUrl ?? 'none'}</span>
      <span data-testid="selected-address">{props.selectedAddress ?? 'none'}</span>
      <button type="button" onClick={props.enterFlow}>
        Enter flow
      </button>
      <button type="button" onClick={props.handleContinue}>
        Continue
      </button>
      <button type="button" onClick={props.handleBack}>
        Back
      </button>
      <button type="button" onClick={props.loadNetworkInterfaces}>
        Refresh addresses
      </button>
    </div>
  )
}))

import MobilePage from './MobilePage'

describe('MobilePage pairing connection mode', () => {
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
    mocks.storeState = {
      closeMobilePage: vi.fn(),
      orcaProfileAuthStatus: { state: 'connected' },
      settings: { showMobileButton: true },
      updateSettings: vi.fn().mockResolvedValue(undefined),
      fetchOrcaProfileAuthStatus: vi.fn().mockResolvedValue(null)
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: vi.fn().mockResolvedValue({ devices: [] }),
          listNetworkInterfaces
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

  it('does not let an abandoned mint populate a new pairing visit', async () => {
    const user = userEvent.setup()
    let resolveAbandonedMint: ((value: Record<string, unknown>) => void) | undefined,
      resolveCurrentMint: ((value: Record<string, unknown>) => void) | undefined
    getPairingQR
      .mockImplementationOnce(() => new Promise((resolve) => (resolveAbandonedMint = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveCurrentMint = resolve)))
    await openPairingStep()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Enter flow' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveAbandonedMint?.({ available: true, qrDataUrl: 'abandoned' })
    })
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
    expect(screen.getByTestId('pair-loading')).toHaveTextContent('true')

    resolveCurrentMint?.({ available: true, qrDataUrl: 'current' })
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('current'))
  })

  it('does not release the mint when a superseded lookup for the same visit settles', async () => {
    const user = userEvent.setup()
    let resolveEntryLookup: ((value: Record<string, unknown>) => void) | undefined
    let resolveManualLookup: ((value: Record<string, unknown>) => void) | undefined
    listNetworkInterfaces
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveEntryLookup = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveManualLookup = resolve
          })
      )
    render(<MobilePage />)
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('intro'))
    await user.click(screen.getByRole('button', { name: 'Enter flow' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    // Overlap refresh within one visit so only request epoch, not visit identity, can distinguish it.
    await user.click(screen.getByRole('button', { name: 'Refresh addresses' }))
    await waitFor(() => expect(listNetworkInterfaces).toHaveBeenCalledTimes(2))

    // The old lookup cannot release minting before its replacement chooses the address.
    await act(async () => {
      resolveEntryLookup?.({ interfaces: [{ name: 'Wi-Fi', address: '10.0.0.5' }] })
    })
    await waitFor(() => expect(screen.getByTestId('pair-loading')).toHaveTextContent('true'))
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('selected-address')).toHaveTextContent('none')

    resolveManualLookup?.({ interfaces: [{ name: 'Wi-Fi', address: '10.0.0.9' }] })
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('10.0.0.9')
    )
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledTimes(1))
    expect(getPairingQR).toHaveBeenCalledWith({
      address: '10.0.0.9',
      connectionMode: 'automatic'
    })
  })
})
