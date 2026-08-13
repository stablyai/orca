import { describe, expect, it } from 'vitest'
import { toSimulatorDeviceRows } from './emulator-device-row-mapping'

describe('toSimulatorDeviceRows', () => {
  it('keeps the backend so the pane can hide iOS-only actions on Android', () => {
    const rows = toSimulatorDeviceRows([
      { backend: 'ios', id: 'udid-1', name: 'iPhone 17 Pro', state: 'booted' },
      { backend: 'android', id: 'emulator-5554', name: 'Pixel 9', state: 'shutdown' }
    ])
    expect(rows.map((row) => row.backend)).toEqual(['ios', 'android'])
  })

  it('normalizes state and carries the remaining fields', () => {
    const rows = toSimulatorDeviceRows([
      {
        id: 'udid-1',
        name: 'iPhone 17 Pro',
        state: 'booted',
        detail: 'iOS 26.2',
        isAvailable: true
      },
      { id: 'udid-2', name: 'iPad', state: 'booting' }
    ])
    expect(rows[0]).toEqual({
      backend: undefined,
      name: 'iPhone 17 Pro',
      udid: 'udid-1',
      state: 'Booted',
      runtime: 'iOS 26.2',
      isAvailable: true
    })
    expect(rows[1].state).toBe('Shutdown')
  })
})
