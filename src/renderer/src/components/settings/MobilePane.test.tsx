// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPairedMobileDevicesCacheForTests,
  type PairedMobileDevice
} from '../mobile/paired-mobile-devices'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

type PairedDevice = PairedMobileDevice

type PairedDevicesProps = {
  devices: readonly PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
}

type StoreState = {
  orcaProfileAuthStatus: { state: 'connected' | 'local' }
  settings: {
    mobileAutoRestoreFitMs: number | null
    mobilePairingConnectionMode?: MobilePairingConnectionMode
  }
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  recordFeatureInteraction: (feature: string) => void
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

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))
vi.mock('./mobile-pairing-device-polling', () => ({ useMobilePairingDevicePolling: vi.fn() }))

// Stub the child sections so the test targets MobilePane's own connection-mode
// safety wiring (effective mode, canGenerate gate, persistence) in isolation.
vi.mock('./MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: (props: {
    connectionMode: MobilePairingConnectionMode
    canGenerate?: boolean
    loading: boolean
    connectionPathControl: React.ReactNode
    onGenerateQr: () => void
  }) => (
    <div>
      <span data-testid="mode">{props.connectionMode}</span>
      <span data-testid="can-generate">{String(props.canGenerate)}</span>
      <span data-testid="loading">{String(props.loading)}</span>
      {props.connectionPathControl}
      {/* Mirror the real Generate gate (loading/canGenerate) so a stuck
          loading flag surfaces as a disabled control the tests can catch. */}
      <button
        type="button"
        onClick={props.onGenerateQr}
        disabled={props.loading || props.canGenerate === false}
      >
        Generate
      </button>
    </div>
  )
}))
vi.mock('./MobilePairingConnectionOptions', () => ({
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
vi.mock('./MobilePairingQrSection', () => ({
  MobilePairingQrSection: (props: { qrDataUrl: string | null }) => (
    <span data-testid="qr">{props.qrDataUrl ?? 'none'}</span>
  )
}))
vi.mock('./MobilePairedDevicesSection', () => ({
  MobilePairedDevicesSection: (props: PairedDevicesProps) => {
    mocks.latestPairedDevicesProps = props
    return <div data-testid="paired-devices">{props.devices.map((d) => d.deviceId).join(',')}</div>
  }
}))
vi.mock('./MobileAutoRestoreFitSection', () => ({ MobileAutoRestoreFitSection: () => <div /> }))
vi.mock('../mobile/WindowsFirewallNotice', () => ({ WindowsFirewallNotice: () => <div /> }))

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
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings,
      recordFeatureInteraction: vi.fn()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: mocks.listDevices,
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    _resetPairedMobileDevicesCacheForTests()
    document.body.innerHTML = ''
  })

  it('defaults to Anywhere and issues an automatic QR when signed in', async () => {
    const user = userEvent.setup()
    render(<MobilePane />)
    expect(screen.getByTestId('mode')).toHaveTextContent('automatic')
    expect(screen.getByTestId('can-generate')).toHaveTextContent('true')

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))
  })

  it('keeps Anywhere selected but blocks generation when signed out', async () => {
    mocks.holder.state.orcaProfileAuthStatus = { state: 'local' }
    const user = userEvent.setup()
    render(<MobilePane />)
    expect(screen.getByTestId('mode')).toHaveTextContent('automatic')
    // Why: the signed-out desktop cannot serve Relay, so Generate is gated off
    // and no misleading local-only QR is minted under the Relay label.
    expect(screen.getByTestId('can-generate')).toHaveTextContent('false')
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(getPairingQR).not.toHaveBeenCalled()
  })

  it('flags an Anywhere mint that degraded to a local-only code', async () => {
    getPairingQR.mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair#degraded',
      endpoint: 'ws://host',
      // Relay provisioning failed server-side; the offer encodes local-only.
      connectionMode: 'local-only'
    })
    const user = userEvent.setup()
    render(<MobilePane />)

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() =>
      expect(screen.getByTestId('relay-degraded-notice')).toHaveTextContent(
        'only works on your local network'
      )
    )

    // Switching to Local network clears the mismatch along with the QR.
    await user.click(screen.getByRole('button', { name: 'choose-local' }))
    await waitFor(() =>
      expect(screen.queryByTestId('relay-degraded-notice')).not.toBeInTheDocument()
    )
  })

  it('does not flag an honest Relay mint', async () => {
    const user = userEvent.setup()
    render(<MobilePane />)

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr'))
    expect(screen.queryByTestId('relay-degraded-notice')).not.toBeInTheDocument()
  })

  it('persists the chosen path when the mode changes', async () => {
    const user = userEvent.setup()
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'choose-local' }))
    expect(updateSettings).toHaveBeenCalledWith({ mobilePairingConnectionMode: 'local-only' })
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')
  })

  it('restores a saved local-only preference without user interaction', () => {
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingConnectionMode: 'local-only'
    }
    render(<MobilePane />)
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')
  })

  it('discards a Relay QR that resolves after signing out mid-generate', async () => {
    const user = userEvent.setup()
    let resolveQr: ((value: Record<string, unknown>) => void) | undefined
    getPairingQR.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQr = resolve
        })
    )
    const { rerender } = render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))

    // Sign out while the Relay mint is still in flight.
    mocks.holder.state.orcaProfileAuthStatus = { state: 'local' }
    rerender(<MobilePane />)

    // The superseded response arrives; it must not paint a QR on a desktop that
    // can no longer serve Relay.
    resolveQr?.({
      available: true,
      qrDataUrl: 'data:image/png;base64,relay',
      pairingUrl: 'orca://relay',
      endpoint: 'ws://relay'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByTestId('qr')).toHaveTextContent('none')
  })

  it('drops loading and re-enables Generate after signing out mid-generate', async () => {
    const user = userEvent.setup()
    let resolveQr: ((value: Record<string, unknown>) => void) | undefined
    getPairingQR.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQr = resolve
        })
    )
    const { rerender } = render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))
    // The hung generate holds the spinner up.
    expect(screen.getByTestId('loading')).toHaveTextContent('true')

    // Sign out while the Relay mint is still in flight; the superseded request
    // must drop loading so Generate isn't wedged disabled forever.
    mocks.holder.state.orcaProfileAuthStatus = { state: 'local' }
    rerender(<MobilePane />)
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))

    // The late response resolves but must not resurrect the spinner.
    resolveQr?.({
      available: true,
      qrDataUrl: 'data:image/png;base64,relay',
      pairingUrl: 'orca://relay',
      endpoint: 'ws://relay'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByTestId('loading')).toHaveTextContent('false')

    // Switching to Local network re-enables Generate (no signed-in gate).
    await user.click(screen.getByRole('button', { name: 'choose-local' }))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
  })

  it('drops loading after switching path mid-generate', async () => {
    const user = userEvent.setup()
    getPairingQR.mockImplementationOnce(() => new Promise(() => {}))
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))
    expect(screen.getByTestId('loading')).toHaveTextContent('true')

    // Switch to Local network before the mint resolves; loading must clear so
    // Generate can be used again for the new path.
    await user.click(screen.getByRole('button', { name: 'choose-local' }))
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
  })

  it('clears a shown QR when another window changes the saved path', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr'))

    // Another window persists a new path; the shared hook syncs it in without
    // routing through changeConnectionMode.
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingConnectionMode: 'local-only'
    }
    rerender(<MobilePane />)

    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('local-only'))
    expect(screen.getByTestId('qr')).toHaveTextContent('none')
  })

  it('discards a QR that resolves after switching path mid-generate', async () => {
    const user = userEvent.setup()
    let resolveQr: ((value: Record<string, unknown>) => void) | undefined
    getPairingQR.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQr = resolve
        })
    )
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))

    // Switch to Local network before the Relay mint resolves.
    await user.click(screen.getByRole('button', { name: 'choose-local' }))

    resolveQr?.({
      available: true,
      qrDataUrl: 'data:image/png;base64,relay',
      pairingUrl: 'orca://relay',
      endpoint: 'ws://relay'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByTestId('qr')).toHaveTextContent('none')
    expect(screen.getByTestId('mode')).toHaveTextContent('local-only')
  })
})

const mountedRoots: Root[] = []

function pairedDevice(deviceId: string): PairedDevice {
  return {
    deviceId,
    name: deviceId,
    pairedAt: 1,
    lastSeenAt: 2
  }
}

async function renderMobilePane(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<MobilePane />)
  })
}

async function unmountMobilePaneRoots(): Promise<void> {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
}

describe('MobilePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPairedMobileDevicesCacheForTests()
    mocks.latestPairedDevicesProps = null
    mocks.getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair',
      endpoint: 'ws://host'
    })
    mocks.listDevices.mockReset()
    mocks.listNetworkInterfaces.mockReset().mockResolvedValue({ interfaces: [] })
    mocks.revokeDevice.mockReset()
    mocks.updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.holder.state = {
      orcaProfileAuthStatus: { state: 'connected' },
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings: mocks.updateSettings,
      recordFeatureInteraction: vi.fn()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR: mocks.getPairingQR,
          listDevices: mocks.listDevices,
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        }
      }
    })
  })

  afterEach(async () => {
    await unmountMobilePaneRoots()
    _resetPairedMobileDevicesCacheForTests()
    document.body.innerHTML = ''
  })

  it('refreshes paired devices from the backend after revoking one', async () => {
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-1')] })
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-2')] })
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    await vi.waitFor(() => expect(mocks.revokeDevice).toHaveBeenCalledWith({ deviceId: 'phone-1' }))
    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-2'])
    )
    // Positive control so the unmount test below can't stay green if the
    // success toast is ever dropped from the revoke path.
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))
  })

  it('shows an error and keeps the device when revoke returns revoked:false', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [pairedDevice('phone-1')] })
    mocks.revokeDevice.mockResolvedValue({ revoked: false })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    // A revoke that did not happen must not fire a second (refresh) IPC call.
    expect(mocks.listDevices).toHaveBeenCalledTimes(1)
    expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
  })

  it('optimistically drops the revoked device when the post-revoke refresh fails', async () => {
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-1'), pairedDevice('phone-2')] })
      .mockRejectedValueOnce(new Error('refresh failed'))
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual([
        'phone-1',
        'phone-2'
      ])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    // Refresh rejected, so the fallback republishes the optimistic list without
    // the revoked device, and success is still reported.
    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-2'])
    )
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))
  })

  it('does not show revoke success after unmounting during the refresh', async () => {
    let resolveRefreshAfterRevoke: (value: { devices: [] }) => void = () => {}
    const refreshAfterRevoke = new Promise<{ devices: [] }>((resolve) => {
      resolveRefreshAfterRevoke = resolve
    })
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-1')] })
      .mockReturnValueOnce(refreshAfterRevoke)
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    await vi.waitFor(() => expect(mocks.listDevices).toHaveBeenCalledTimes(2))
    await unmountMobilePaneRoots()

    await act(async () => {
      resolveRefreshAfterRevoke({ devices: [] })
    })

    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
