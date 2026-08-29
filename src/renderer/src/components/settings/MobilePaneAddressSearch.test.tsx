// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StoreState = {
  orcaProfileAuthStatus: { state: 'connected' }
  settingsSearchQuery: string
  settings: { mobileAutoRestoreFitMs: number | null }
  updateSettings: () => Promise<void>
  recordFeatureInteraction: () => void
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: {} as StoreState }
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return { holder, useAppStore }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
// `i18n` is read by the localized search catalogs the pane consults to decide
// whether a query targets the address picker.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./mobile-pairing-device-polling', () => ({ useMobilePairingDevicePolling: vi.fn() }))
vi.mock('./MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: (props: { addressDisclosureForcedOpen?: boolean }) => (
    <div data-testid="address-forced-open">{String(props.addressDisclosureForcedOpen)}</div>
  )
}))
vi.mock('./MobilePairingConnectionOptions', () => ({
  MobilePairingConnectionOptions: () => <div />
}))
vi.mock('./MobilePairingQrSection', () => ({ MobilePairingQrSection: () => <div /> }))
vi.mock('./MobilePairedDevicesSection', () => ({ MobilePairedDevicesSection: () => <div /> }))
vi.mock('./MobileAutoRestoreFitSection', () => ({ MobileAutoRestoreFitSection: () => <div /> }))
vi.mock('../mobile/WindowsFirewallNotice', () => ({ WindowsFirewallNotice: () => <div /> }))

import { MobilePane } from './MobilePane'

describe('MobilePane address disclosure search wiring', () => {
  beforeEach(() => {
    mocks.holder.state = {
      orcaProfileAuthStatus: { state: 'connected' },
      settingsSearchQuery: '',
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings: vi.fn().mockResolvedValue(undefined),
      recordFeatureInteraction: vi.fn()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR: vi.fn(),
          listDevices: vi.fn().mockResolvedValue({ devices: [] }),
          listNetworkInterfaces: vi.fn().mockResolvedValue({ interfaces: [] }),
          revokeDevice: vi.fn()
        }
      }
    })
  })

  afterEach(() => cleanup())

  // Why: an empty query matches every catalog entry, so a missing blank guard
  // would spring the disclosure open the moment Settings mounts.
  it.each([
    ['', 'false'],
    ['revoke', 'false'],
    ['tailscale', 'true'],
    ['Network Interface', 'true']
  ])('forces the disclosure open for %j: %s', (query, forced) => {
    mocks.holder.state.settingsSearchQuery = query
    render(<MobilePane />)
    expect(screen.getByTestId('address-forced-open')).toHaveTextContent(forced)
  })
})
