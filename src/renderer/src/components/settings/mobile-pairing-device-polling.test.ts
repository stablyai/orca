import { describe, expect, it } from 'vitest'
import { shouldPollMobilePairingDevices } from './mobile-pairing-device-polling'

describe('mobile pairing device polling', () => {
  it('polls only while waiting for a new device in the visible focused window', () => {
    expect(
      shouldPollMobilePairingDevices({
        deviceCountAtQr: 1,
        currentDeviceCount: 1,
        visibilityState: 'visible',
        focused: true
      })
    ).toBe(true)

    expect(
      shouldPollMobilePairingDevices({
        deviceCountAtQr: 1,
        currentDeviceCount: 2,
        visibilityState: 'visible',
        focused: true
      })
    ).toBe(false)

    expect(
      shouldPollMobilePairingDevices({
        deviceCountAtQr: 1,
        currentDeviceCount: 1,
        visibilityState: 'hidden',
        focused: true
      })
    ).toBe(false)

    expect(
      shouldPollMobilePairingDevices({
        deviceCountAtQr: 1,
        currentDeviceCount: 1,
        visibilityState: 'visible',
        focused: false
      })
    ).toBe(false)
  })
})
