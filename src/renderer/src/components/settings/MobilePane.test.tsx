// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPairedMobileDevicesCacheForTests,
  type PairedMobileDevice
} from '../mobile/paired-mobile-devices'

type PairedDevice = PairedMobileDevice

type PairedDevicesProps = {
  devices: readonly PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
}

type StoreState = {
  settings: {
    mobileAutoRestoreFitMs: number | null
  }
  updateSettings: (settings: { mobileAutoRestoreFitMs: number | null }) => void
}

const mocks = vi.hoisted(() => ({
  latestPairedDevicesProps: null as PairedDevicesProps | null,
  listDevices: vi.fn(),
  listNetworkInterfaces: vi.fn(),
  revokeDevice: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  updateSettings: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) =>
    selector({
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings: mocks.updateSettings
    })
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

vi.mock('./MobileNetworkInterfaceSection', () => ({
  MobileNetworkInterfaceSection: () => null
}))

vi.mock('./MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: () => null
}))

vi.mock('./MobilePairingQrSection', () => ({
  MobilePairingQrSection: () => null
}))

vi.mock('./MobileAutoRestoreFitSection', () => ({
  MobileAutoRestoreFitSection: () => null
}))

vi.mock('./MobilePairedDevicesSection', () => ({
  MobilePairedDevicesSection: (props: PairedDevicesProps) => {
    mocks.latestPairedDevicesProps = props
    return <div data-testid="paired-devices">{props.devices.map((d) => d.deviceId).join(',')}</div>
  }
}))

import { MobilePane } from './MobilePane'

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
    mocks.latestPairedDevicesProps = null
    _resetPairedMobileDevicesCacheForTests()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          listDevices: mocks.listDevices,
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        }
      }
    })
    mocks.listNetworkInterfaces.mockResolvedValue({ interfaces: [] })
  })

  afterEach(async () => {
    await unmountMobilePaneRoots()
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
