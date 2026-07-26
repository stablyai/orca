// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPairedMobileDevicesCacheForTests,
  replacePairedMobileDevices,
  refreshPairedMobileDevices
} from './paired-mobile-devices'

const listDevices = vi.fn()

describe('paired mobile devices', () => {
  beforeEach(() => {
    _resetPairedMobileDevicesCacheForTests()
    listDevices.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          listDevices
        }
      }
    })
  })

  it('coalesces concurrent refreshes onto one mobile device IPC call', async () => {
    let resolveLookup: (value: { devices: [] }) => void = () => {}
    const lookup = new Promise<{ devices: [] }>((resolve) => {
      resolveLookup = resolve
    })
    listDevices.mockReturnValueOnce(lookup)

    const first = refreshPairedMobileDevices()
    const second = refreshPairedMobileDevices()

    expect(listDevices).toHaveBeenCalledTimes(1)

    resolveLookup({ devices: [] })
    await expect(Promise.all([first, second])).resolves.toEqual([[], []])
  })

  it('returns the current cache when a newer write supersedes an in-flight refresh', async () => {
    const staleDevice = { deviceId: 'old-phone', name: 'Old phone', pairedAt: 1, lastSeenAt: 2 }
    const currentDevice = { deviceId: 'new-phone', name: 'New phone', pairedAt: 3, lastSeenAt: 4 }
    let resolveLookup: (value: { devices: [typeof staleDevice] }) => void = () => {}
    const lookup = new Promise<{ devices: [typeof staleDevice] }>((resolve) => {
      resolveLookup = resolve
    })
    listDevices.mockReturnValueOnce(lookup)

    const refresh = refreshPairedMobileDevices()
    replacePairedMobileDevices([currentDevice])

    resolveLookup({ devices: [staleDevice] })

    await expect(refresh).resolves.toEqual([currentDevice])
  })

  it('returns the newer refresh when a superseded refresh fails', async () => {
    const currentDevice = { deviceId: 'new-phone', name: 'New phone', pairedAt: 3, lastSeenAt: 4 }
    let rejectStaleLookup: (reason?: unknown) => void = () => {}
    let resolveCurrentLookup: (value: { devices: [typeof currentDevice] }) => void = () => {}
    const staleLookup = new Promise<{ devices: [] }>((_, reject) => {
      rejectStaleLookup = reject
    })
    const currentLookup = new Promise<{ devices: [typeof currentDevice] }>((resolve) => {
      resolveCurrentLookup = resolve
    })
    listDevices.mockReturnValueOnce(staleLookup).mockReturnValueOnce(currentLookup)

    const staleRefresh = refreshPairedMobileDevices()
    const currentRefresh = refreshPairedMobileDevices({ force: true })
    const staleExpectation = expect(staleRefresh).resolves.toEqual([currentDevice])

    rejectStaleLookup(new Error('stale failure'))
    resolveCurrentLookup({ devices: [currentDevice] })

    await expect(currentRefresh).resolves.toEqual([currentDevice])
    await staleExpectation
  })
})
