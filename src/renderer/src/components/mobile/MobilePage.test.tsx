// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

type StoreState = {
  closeMobilePage: () => void
  orcaProfileAuthStatus: { state: 'connected' | 'local' }
  settings: { showMobileButton: boolean; mobilePairingConnectionMode?: MobilePairingConnectionMode }
  updateSettings: () => Promise<void>
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
vi.mock('../settings/mobile-pairing-device-polling', () => ({
  useMobilePairingDevicePolling: vi.fn()
}))

vi.mock('./MobilePageContent', () => ({
  MobilePageContent: (props: {
    connectionMode: MobilePairingConnectionMode
    canGeneratePairing: boolean
    enterFlow: () => void
    handleConnectionModeChange: (mode: MobilePairingConnectionMode) => void
    handleAddressChange: (address: string) => void
    handleContinue: () => void
    pairQrDataUrl: string | null
    pairingUrl: string | null
    stage: string | null
    stepIdx: number
  }) => (
    <div>
      <span data-testid="stage">{props.stage ?? 'loading'}</span>
      <span data-testid="step">{props.stepIdx}</span>
      <span data-testid="mode">{props.connectionMode}</span>
      <span data-testid="can-generate">{String(props.canGeneratePairing)}</span>
      <span data-testid="pairing-qr">{props.pairQrDataUrl ?? 'none'}</span>
      <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
      <button type="button" onClick={props.enterFlow}>
        Enter flow
      </button>
      <button type="button" onClick={props.handleContinue}>
        Continue
      </button>
      <button type="button" onClick={() => props.handleConnectionModeChange('automatic')}>
        Orca Relay
      </button>
      <button type="button" onClick={() => props.handleConnectionModeChange('local-only')}>
        LAN
      </button>
      <button type="button" onClick={() => props.handleAddressChange('10.0.0.2')}>
        Change address
      </button>
    </div>
  )
}))

import MobilePage from './MobilePage'

describe('MobilePage pairing connection mode', () => {
  const getPairingQR = vi.fn()

  beforeEach(() => {
    getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair#automatic'
    })
    mocks.storeState = {
      closeMobilePage: vi.fn(),
      orcaProfileAuthStatus: { state: 'connected' },
      settings: { showMobileButton: true },
      updateSettings: vi.fn().mockResolvedValue(undefined)
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: vi.fn().mockResolvedValue({ devices: [] }),
          listNetworkInterfaces: vi.fn().mockResolvedValue({ interfaces: [] })
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

  it('defaults signed-in pairing to Anywhere and remints when same-network is selected', async () => {
    const user = userEvent.setup()
    await openPairingStep()

    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))
    expect(screen.getByTestId('mode')).toHaveTextContent('automatic')

    let resolveRotatedLocalQr: ((value: Record<string, unknown>) => void) | undefined
    getPairingQR.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRotatedLocalQr = resolve
        })
    )
    await user.click(screen.getByRole('button', { name: 'LAN' }))
    // No rotate flag: the main process rotates exactly once on the policy
    // mismatch, so concurrent windows converge on the same fresh token.
    await waitFor(() =>
      expect(getPairingQR).toHaveBeenLastCalledWith({
        connectionMode: 'local-only'
      })
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')
    // The prior Relay QR clears immediately so the old policy's code is never
    // shown while the reminted local-only offer is still pending.
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
    expect(mocks.storeState.updateSettings).toHaveBeenCalledWith({
      mobilePairingConnectionMode: 'local-only'
    })

    resolveRotatedLocalQr?.({
      available: true,
      qrDataUrl: 'data:image/png;base64,local-qr',
      pairingUrl: 'orca://pair#local'
    })
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('local-qr'))
  })

  it('restores a saved local-only preference without user interaction', async () => {
    mocks.storeState.settings = {
      showMobileButton: true,
      mobilePairingConnectionMode: 'local-only'
    }
    await openPairingStep()

    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'local-only' }))
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')
  })

  it('does not auto-mint any QR when signed out with Anywhere selected', async () => {
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    await openPairingStep()

    // Aligned with Settings: signed-out Anywhere cannot serve Relay, so we mint
    // nothing rather than a scannable local-only QR under the Relay label.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('mode')).toHaveTextContent('automatic')
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
    expect(screen.getByTestId('can-generate')).toHaveTextContent('false')
  })

  it('mints a local-only QR when switching to LAN while signed out', async () => {
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    const user = userEvent.setup()
    await openPairingStep()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPairingQR).not.toHaveBeenCalled()

    // Picking LAN is an honest local-only path, so a QR mints.
    await user.click(screen.getByRole('button', { name: 'LAN' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'local-only' }))
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')
  })

  it('does not remint when switching from Local to Anywhere while signed out', async () => {
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    const user = userEvent.setup()
    await openPairingStep()

    await user.click(screen.getByRole('button', { name: 'LAN' }))
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))
    getPairingQR.mockClear()

    // Switching back to Orca Relay must clear the local QR, not remint a
    // local-only code under the Relay label.
    await user.click(screen.getByRole('button', { name: 'Orca Relay' }))
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('automatic'))
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('can-generate')).toHaveTextContent('false')
  })

  it('does not mint on address change while signed out with Anywhere selected', async () => {
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    const user = userEvent.setup()
    await openPairingStep()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPairingQR).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Change address' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
  })

  it('mints a Relay QR when signing in with Anywhere selected', async () => {
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    const user = userEvent.setup()
    const { rerender } = render(<MobilePage />)
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('intro'))
    await user.click(screen.getByRole('button', { name: 'Enter flow' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    // Signed-out Anywhere shows no QR at all.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')

    // Hold the sign-in mint pending so we can inspect the upgrade window.
    let resolveRelayQr: ((value: Record<string, unknown>) => void) | undefined
    getPairingQR.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRelayQr = resolve
        })
    )

    // Signing in unlocks Relay, so Step 2 mints an honest Relay QR.
    mocks.storeState.orcaProfileAuthStatus = { state: 'connected' }
    rerender(<MobilePage />)
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))
    // Between the auth flip and the mint resolving, no code may be shown — the
    // QR must not flash a stale/optimistic value while the Relay offer is pending.
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none')
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')

    resolveRelayQr?.({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair#automatic'
    })
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))
    expect(screen.getByTestId('mode')).toHaveTextContent('automatic')
  })

  it('removes the old QR if policy rotation fails', async () => {
    const user = userEvent.setup()
    await openPairingStep()
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))

    getPairingQR.mockRejectedValueOnce(new Error('rotation failed'))
    await user.click(screen.getByRole('button', { name: 'LAN' }))

    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none'))
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
  })
})
