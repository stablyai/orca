import { describe, expect, it } from 'vitest'
import {
  resolveAdbDefaultHygieneSerial,
  shouldClearAdbDefaultDevice
} from './mobile-emulator-adb-default-device-hygiene'

describe('shouldClearAdbDefaultDevice', () => {
  it('clears when the default device is exactly the previous runtime serial', () => {
    expect(shouldClearAdbDefaultDevice('192.168.1.50:5555', '192.168.1.50:5555')).toBe(true)
  })

  it('preserves an unrelated Android emulator serial', () => {
    expect(shouldClearAdbDefaultDevice('emulator-5554', '192.168.1.50:5555')).toBe(false)
  })

  it('preserves an unrelated iOS Simulator UDID', () => {
    expect(
      shouldClearAdbDefaultDevice('11111111-2222-3333-4444-555555555555', '192.168.1.50:5555')
    ).toBe(false)
  })

  it('preserves a null default device (auto-select)', () => {
    expect(shouldClearAdbDefaultDevice(null, '192.168.1.50:5555')).toBe(false)
  })

  it('preserves an undefined default device', () => {
    expect(shouldClearAdbDefaultDevice(undefined, '192.168.1.50:5555')).toBe(false)
  })

  it('never clears when there was no previous runtime serial to compare against', () => {
    expect(shouldClearAdbDefaultDevice('192.168.1.50:5555', null)).toBe(false)
    expect(shouldClearAdbDefaultDevice('192.168.1.50:5555', undefined)).toBe(false)
  })

  it('is a strict comparison, not a prefix/substring match', () => {
    expect(shouldClearAdbDefaultDevice('192.168.1.50:55555', '192.168.1.50:5555')).toBe(false)
  })
})

describe('resolveAdbDefaultHygieneSerial', () => {
  const emptyStatus = { address: null, serial: null }

  it('falls back to the previous address before any status has arrived', () => {
    expect(resolveAdbDefaultHygieneSerial(emptyStatus, '192.168.1.50:5555')).toBe(
      '192.168.1.50:5555'
    )
  })

  it('uses the observed serial when status matches the previous address', () => {
    expect(
      resolveAdbDefaultHygieneSerial(
        { address: '192.168.1.50:5555', serial: '192.168.1.50:5555' },
        '192.168.1.50:5555'
      )
    ).toBe('192.168.1.50:5555')
  })

  it('falls back to the previous address when matching status has no serial yet', () => {
    expect(
      resolveAdbDefaultHygieneSerial(
        { address: '192.168.1.50:5555', serial: null },
        '192.168.1.50:5555'
      )
    ).toBe('192.168.1.50:5555')
  })

  it('ignores a stale status pair from a different address', () => {
    expect(
      resolveAdbDefaultHygieneSerial(
        { address: '10.0.0.8:5555', serial: '10.0.0.8:5555' },
        '192.168.1.50:5555'
      )
    ).toBe('192.168.1.50:5555')
  })

  it('returns null when there is no previous address and no status serial', () => {
    expect(resolveAdbDefaultHygieneSerial(emptyStatus, null)).toBeNull()
  })
})
