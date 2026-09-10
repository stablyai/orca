import { describe, expect, it } from 'vitest'
import { toSimulatorDeviceRows, type RawEmulatorDevice } from './emulator-device-row-mapping'

const capabilities = {
  shutdown: true,
  power: true,
  volume: true,
  overview: true,
  foldable: false,
  wearButton1: false,
  wearButton2: false
}

describe('toSimulatorDeviceRows', () => {
  it('preserves backend and Android control capabilities', () => {
    const raw: RawEmulatorDevice[] = [
      {
        id: 'emulator-5554',
        name: 'Pixel 7',
        state: 'booted',
        detail: 'emulator',
        isAvailable: true,
        backend: 'android',
        controlCapabilities: capabilities
      }
    ]

    expect(toSimulatorDeviceRows(raw)[0]).toEqual({
      name: 'Pixel 7',
      udid: 'emulator-5554',
      state: 'Booted',
      runtime: 'emulator',
      isAvailable: true,
      backend: 'android',
      controlCapabilities: capabilities
    })
  })

  it('leaves optional fields undefined for legacy inventory entries', () => {
    expect(
      toSimulatorDeviceRows([{ id: 'simulator', name: 'iPhone', state: 'shutdown' }])[0]
    ).toEqual({
      name: 'iPhone',
      udid: 'simulator',
      state: 'Shutdown',
      runtime: undefined,
      isAvailable: undefined,
      backend: undefined,
      controlCapabilities: undefined
    })
  })
})
