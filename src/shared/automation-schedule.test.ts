import { describe, expect, it } from 'vitest'
import { isScheduleTriggerEnabled } from './automation-schedule'

describe('isScheduleTriggerEnabled', () => {
  it('is true when scheduleEnabled is true', () => {
    expect(isScheduleTriggerEnabled({ scheduleEnabled: true })).toBe(true)
  })

  it('is false when scheduleEnabled is false', () => {
    expect(isScheduleTriggerEnabled({ scheduleEnabled: false })).toBe(false)
  })

  it('treats a legacy automation without the field as enabled', () => {
    // Automations persisted before the field existed have scheduleEnabled
    // undefined at runtime; they must keep firing without a migration.
    expect(isScheduleTriggerEnabled({})).toBe(true)
  })
})
