// @vitest-environment happy-dom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetPairedMobileDevicesCacheForTests } from './paired-mobile-devices'
import type { StepIndex } from './MobileHero'

const mocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

// Polling drives its own timers/IPC that are out of scope here; stub it out so
// the only listDevices calls are the ones this hook makes directly.
vi.mock('../settings/mobile-pairing-device-polling', () => ({
  useMobilePairingDevicePolling: (): void => {}
}))

import { useMobilePagePairedDevices } from './use-mobile-page-paired-devices'

type HookApi = ReturnType<typeof useMobilePagePairedDevices>

let latest: HookApi | null = null
let latestStep: StepIndex | null = null

function Probe(): null {
  const [stepIdx, setStepIdx] = useState<StepIndex>(0)
  latestStep = stepIdx
  latest = useMobilePagePairedDevices({ stepIdx, setStepIdx })
  return null
}

const mountedRoots: Root[] = []

function device(deviceId: string): {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
} {
  return { deviceId, name: deviceId, pairedAt: 1, lastSeenAt: 2 }
}

async function renderProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(Probe))
  })
}

async function unmountProbes(): Promise<void> {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
}

describe('useMobilePagePairedDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latest = null
    latestStep = null
    _resetPairedMobileDevicesCacheForTests()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          listDevices: mocks.listDevices,
          revokeDevice: mocks.revokeDevice
        }
      }
    })
  })

  afterEach(async () => {
    await unmountProbes()
    document.body.innerHTML = ''
  })

  it('resolves to the paired stage when a device is already paired', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device('phone-1')] })

    await renderProbe()

    await vi.waitFor(() => expect(latest?.stage).toBe('paired'))
    expect(latest?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
  })

  it('returns to the paired summary from step 0 while devices exist', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device('phone-1')] })

    await renderProbe()
    await vi.waitFor(() => expect(latest?.stage).toBe('paired'))

    await act(async () => {
      latest?.enterFlow()
    })
    expect(latest?.stage).toBe('flow')

    await act(async () => {
      latest?.handleBack()
    })
    expect(latest?.stage).toBe('paired')
  })

  it('returns to intro from step 0 when no devices exist', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [] })

    await renderProbe()
    await vi.waitFor(() => expect(latest?.stage).toBe('intro'))

    await act(async () => {
      latest?.enterFlow()
    })
    expect(latest?.stage).toBe('flow')

    await act(async () => {
      latest?.handleBack()
    })
    expect(latest?.stage).toBe('intro')
  })

  it('steps back to step 0 from step 1 without leaving the flow', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device('phone-1')] })

    await renderProbe()
    await vi.waitFor(() => expect(latest?.stage).toBe('paired'))

    await act(async () => {
      latest?.pairAnotherDevice()
    })
    expect(latestStep).toBe(1)
    expect(latest?.stage).toBe('flow')

    await act(async () => {
      latest?.handleBack()
    })
    expect(latestStep).toBe(0)
    expect(latest?.stage).toBe('flow')
  })

  it('keeps the device and shows an error when revoke returns revoked:false', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device('phone-1')] })
    mocks.revokeDevice.mockResolvedValue({ revoked: false })

    await renderProbe()
    await vi.waitFor(() => expect(latest?.stage).toBe('paired'))

    await act(async () => {
      await latest?.revokeDevice('phone-1')
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    // A revoke that did not happen must not fire a second (refresh) IPC call.
    expect(mocks.listDevices).toHaveBeenCalledTimes(1)
    expect(latest?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
  })

  it('routes to intro after revoking the last device', async () => {
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [device('phone-1')] })
      .mockResolvedValueOnce({ devices: [] })
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderProbe()
    await vi.waitFor(() => expect(latest?.stage).toBe('paired'))

    await act(async () => {
      await latest?.revokeDevice('phone-1')
    })

    expect(mocks.revokeDevice).toHaveBeenCalledWith({ deviceId: 'phone-1' })
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(latest?.stage).toBe('intro'))
    expect(latest?.devices).toEqual([])
  })

  it('optimistically drops the device and still succeeds when the post-revoke refresh fails', async () => {
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [device('phone-1')] })
      .mockRejectedValueOnce(new Error('refresh failed'))
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderProbe()
    await vi.waitFor(() => expect(latest?.stage).toBe('paired'))

    await act(async () => {
      await latest?.revokeDevice('phone-1')
    })

    // Revoke succeeded server-side, so success is reported and the device is
    // dropped optimistically even though the reload failed — no false error.
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(latest?.devices).toEqual([]))
    await vi.waitFor(() => expect(latest?.stage).toBe('intro'))
  })
})
