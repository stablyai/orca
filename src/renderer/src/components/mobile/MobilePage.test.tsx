// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

type StoreState = {
  closeMobilePage: () => void
  orcaProfileAuthStatus: { state: 'connected' | 'local' }
  settings: { showMobileButton: boolean }
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
    enterFlow: () => void
    handleConnectionModeChange: (mode: MobilePairingConnectionMode) => void
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
      <span data-testid="pairing-qr">{props.pairQrDataUrl ?? 'none'}</span>
      <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
      <button type="button" onClick={props.enterFlow}>
        Enter flow
      </button>
      <button type="button" onClick={props.handleContinue}>
        Continue
      </button>
      <button type="button" onClick={() => props.handleConnectionModeChange('automatic')}>
        Anywhere
      </button>
      <button type="button" onClick={() => props.handleConnectionModeChange('local-only')}>
        Local only
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

  it('defaults signed-in pairing to local-only and rotates when Relay is selected', async () => {
    const user = userEvent.setup()
    await openPairingStep()

    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'local-only' }))
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')

    let resolveRelayQr: ((value: Record<string, unknown>) => void) | undefined
    getPairingQR.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRelayQr = resolve
        })
    )
    await user.click(screen.getByRole('button', { name: 'Anywhere' }))
    await waitFor(() =>
      expect(getPairingQR).toHaveBeenLastCalledWith({
        connectionMode: 'automatic',
        rotate: true
      })
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('automatic')
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr')
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')

    resolveRelayQr?.({
      available: true,
      qrDataUrl: 'data:image/png;base64,relay-qr',
      pairingUrl: 'orca://pair#relay'
    })
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('relay-qr'))
  })

  it('defaults signed-out pairing to local-only', async () => {
    mocks.storeState.orcaProfileAuthStatus = { state: 'local' }
    await openPairingStep()

    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'local-only' }))
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')
  })

  it('removes the old QR if policy rotation fails', async () => {
    const user = userEvent.setup()
    await openPairingStep()
    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('base64,qr'))

    getPairingQR.mockRejectedValueOnce(new Error('rotation failed'))
    await user.click(screen.getByRole('button', { name: 'Anywhere' }))

    await waitFor(() => expect(screen.getByTestId('pairing-qr')).toHaveTextContent('none'))
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('none')
  })
})
