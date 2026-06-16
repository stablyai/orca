import { describe, expect, it } from 'vitest'
import { markSimulatorDeviceBooted, markSimulatorDeviceShutdown } from './emulator-device-state'
import type { SimulatorDeviceRow } from './emulator-pane-types'

const devices: SimulatorDeviceRow[] = [
  { name: 'iPhone 17 Pro', udid: 'iphone-pro', state: 'Booted' },
  { name: 'iPhone 17 Pro Max', udid: 'iphone-max', state: 'Shutdown' },
  { name: 'iPad Pro', udid: 'ipad-pro', state: 'Shutdown' }
]

describe('markSimulatorDeviceBooted', () => {
  it('marks the attached UDID as booted without changing other rows', () => {
    expect(markSimulatorDeviceBooted(devices, 'iphone-max')).toEqual([
      { name: 'iPhone 17 Pro', udid: 'iphone-pro', state: 'Booted' },
      { name: 'iPhone 17 Pro Max', udid: 'iphone-max', state: 'Booted' },
      { name: 'iPad Pro', udid: 'ipad-pro', state: 'Shutdown' }
    ])
  })

  it('also accepts device names from external attach events', () => {
    expect(markSimulatorDeviceBooted(devices, 'iPad Pro')[2]?.state).toBe('Booted')
  })

  it('returns the original array when there is no matching target', () => {
    expect(markSimulatorDeviceBooted(devices, 'missing-device')).toBe(devices)
  })

  it('marks a device as shutdown after explicit cleanup', () => {
    expect(markSimulatorDeviceShutdown(devices, 'iphone-pro')[0]?.state).toBe('Shutdown')
  })
})
