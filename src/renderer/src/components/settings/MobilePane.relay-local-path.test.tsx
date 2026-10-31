// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { _resetPairedMobileDevicesCacheForTests } from '../mobile/paired-mobile-devices'

type StoreState = { settings: Record<string, unknown> } & Record<string, unknown>

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: { settings: {} } }
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return { holder, useAppStore, getPairingQR: vi.fn() }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./mobile-pairing-device-polling', () => ({ useMobilePairingDevicePolling: vi.fn() }))
vi.mock('./MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: (props: { onGenerateQr: () => void }) => (
    <button type="button" onClick={props.onGenerateQr}>
      Generate
    </button>
  )
}))
vi.mock('./MobilePairingConnectionOptions', () => ({ MobilePairingConnectionOptions: () => null }))
vi.mock('./MobilePairingQrSection', () => ({
  MobilePairingQrSection: (props: { pairingUrl: string | null }) => (
    <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
  )
}))
vi.mock('./MobilePairedDevicesSection', () => ({ MobilePairedDevicesSection: () => null }))
vi.mock('./MobileAutoRestoreFitSection', () => ({ MobileAutoRestoreFitSection: () => null }))
vi.mock('./MachineNameField', () => ({ MachineNameField: () => null }))
vi.mock('../mobile/WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: (props: { pairingReady: boolean }) => (
    <span data-testid="firewall-ready">{String(props.pairingReady)}</span>
  )
}))

import { MobilePane } from './MobilePane'

afterEach(() => {
  cleanup()
  _resetPairedMobileDevicesCacheForTests()
})

function renderSignedInPane(endpoint: string | null): ReturnType<typeof render> {
  mocks.getPairingQR.mockResolvedValue({
    available: true,
    qrDataUrl: 'data:image/png;base64,qr',
    pairingUrl: 'orca://pair',
    endpoint,
    connectionMode: 'automatic'
  })
  mocks.holder.state = {
    orcaProfileAuthStatus: { state: 'connected' },
    settingsSearchQuery: '',
    settings: { mobileAutoRestoreFitMs: null },
    updateSettings: vi.fn().mockResolvedValue(undefined),
    recordFeatureInteraction: vi.fn(),
    fetchOrcaProfileAuthStatus: vi.fn().mockResolvedValue(null)
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      mobile: {
        getPairingQR: mocks.getPairingQR,
        listDevices: vi.fn().mockResolvedValue({ devices: [] }),
        listNetworkInterfaces: vi.fn().mockResolvedValue({ interfaces: [] })
      },
      ui: { writeClipboardText: vi.fn() }
    }
  })
  return render(<MobilePane />)
}

describe('MobilePane Relay local path', () => {
  it('remints a shown code as soon as the local path changes', async () => {
    const user = userEvent.setup()
    const { rerender } = renderSignedInPane(null)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(mocks.getPairingQR).toHaveBeenCalledOnce())

    // A stale code keeps its old reach until main rotates it on the next mint.
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingRelayLocalPath: false
    }
    rerender(<MobilePane />)
    await waitFor(() =>
      expect(mocks.getPairingQR).toHaveBeenLastCalledWith({
        connectionMode: 'automatic',
        localPath: false
      })
    )
  })

  it('offers the firewall fix only for a code that advertises a direct address', async () => {
    const user = userEvent.setup()
    renderSignedInPane(null)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('pairing-url')).toHaveTextContent('orca://pair'))
    expect(screen.getByTestId('firewall-ready')).toHaveTextContent('false')

    cleanup()
    renderSignedInPane('ws://192.168.1.24:6768')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('firewall-ready')).toHaveTextContent('true'))
  })
})
