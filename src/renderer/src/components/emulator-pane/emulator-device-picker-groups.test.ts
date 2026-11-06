import { describe, expect, it } from 'vitest'
import { groupEmulatorDevices, emulatorDeviceDescription } from './emulator-device-picker-groups'
import { toSimulatorDeviceRows } from './emulator-device-row-mapping'

describe('emulator picker inventory', () => {
  it('keeps unavailable records out of used devices and retains every duplicate identity', () => {
    const rows = toSimulatorDeviceRows([
      {
        id: 'old',
        name: 'iPhone 18 Pro',
        backend: 'ios',
        state: 'shutdown',
        detail: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
        isAvailable: false,
        lastUsedAt: '2026-10-30',
        availabilityError: 'runtime removed'
      },
      {
        id: 'used',
        name: 'iPhone 18 Pro',
        backend: 'ios',
        state: 'shutdown',
        detail: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
        isAvailable: true,
        lastUsedAt: '2026-10-31'
      },
      {
        id: 'unused',
        name: 'iPhone 18 Pro',
        backend: 'ios',
        state: 'shutdown',
        detail: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
        isAvailable: true
      },
      {
        id: 'pixel',
        name: 'Pixel',
        backend: 'android',
        state: 'booted',
        osVersion: '16',
        apiLevel: '36',
        isAvailable: true
      }
    ])
    const groups = groupEmulatorDevices(rows, 'old')
    expect(groups.used.map((d) => d.udid)).toEqual(['used', 'pixel'])
    expect(groups.other.map((d) => d.udid)).toEqual(['unused'])
    expect(groups.unavailable.map((d) => d.udid)).toEqual(['old'])
    expect(groups.unavailable[0].availabilityError).toBe('runtime removed')
    expect(emulatorDeviceDescription(rows[1])).toContain('iOS 27.2')
    expect(emulatorDeviceDescription(rows[3])).toBe('Android 16 · API 36')
  })

  it('includes the selected shutdown device and tolerates metadata from older hosts', () => {
    const rows = toSimulatorDeviceRows([
      { id: 'legacy', name: 'Phone', state: 'shutdown' },
      { id: 'selected', name: 'Tablet', state: 'shutdown' }
    ])
    const groups = groupEmulatorDevices(rows, 'selected')
    expect(groups.used.map((d) => d.udid)).toEqual(['selected'])
    expect(groups.other.map((d) => d.udid)).toEqual(['legacy'])
    expect(emulatorDeviceDescription(rows[0])).toBe('')
  })
})
