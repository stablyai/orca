import { describe, expect, it } from 'vitest'
import {
  formatMachineWorkAtRisk,
  machineLocalExpiresAt,
  machineMsUntilExpiry
} from './machine-inventory'

describe('formatMachineWorkAtRisk', () => {
  const t = (_key: string, value: string, values: { count: number }) =>
    value.replace('{{count}}', String(values.count))
  it('names only the kinds present, with singular and plural forms', () => {
    expect(formatMachineWorkAtRisk({ uncommitted: 1, unpushed: 0 }, t)).toBe('1 uncommitted change')
    expect(formatMachineWorkAtRisk({ uncommitted: 2, unpushed: 1 }, t)).toBe(
      '2 uncommitted changes, 1 unpushed commit'
    )
    expect(formatMachineWorkAtRisk({ uncommitted: 0, unpushed: 3 }, t)).toBe('3 unpushed commits')
    expect(formatMachineWorkAtRisk({ uncommitted: 0, unpushed: 0 }, t)).toBeNull()
    expect(formatMachineWorkAtRisk({ uncommitted: 0, unpushed: 0, neverPushed: 1 }, t)).toBe(
      '1 branch never pushed'
    )
    expect(formatMachineWorkAtRisk({ uncommitted: 0, unpushed: 0, neverPushed: 2 }, t)).toBe(
      '2 branches never pushed'
    )
  })
})

describe('machine expiry on the provider clock', () => {
  it('shifts expiresAt by the provider clock offset', () => {
    const machine = { expiresAt: '2026-10-18T12:00:00.000Z' }
    const at = Date.parse(machine.expiresAt)
    expect(machineLocalExpiresAt(machine, 5_000)).toBe(at - 5_000)
    expect(machineMsUntilExpiry(machine, 5_000, at - 65_000)).toBe(60_000)
    expect(machineLocalExpiresAt({}, 5_000)).toBeNull()
  })
})
