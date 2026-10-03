import { describe, expect, it } from 'vitest'
import {
  parseDatetimeLocalValue,
  resolveWorkspaceSnoozePresetWakeAt,
  toDatetimeLocalValue
} from './workspace-snooze-presets'

// Wednesday 2026-09-30 15:20 local time.
const wednesday = new Date(2026, 8, 30, 15, 20)

describe('workspace snooze presets', () => {
  it('adds hours for the relative presets', () => {
    expect(resolveWorkspaceSnoozePresetWakeAt('one-hour', wednesday)).toBe(
      wednesday.getTime() + 60 * 60 * 1000
    )
    expect(resolveWorkspaceSnoozePresetWakeAt('five-hours', wednesday)).toBe(
      wednesday.getTime() + 5 * 60 * 60 * 1000
    )
  })

  it('wakes tomorrow at 9 AM local time', () => {
    expect(resolveWorkspaceSnoozePresetWakeAt('tomorrow-morning', wednesday)).toBe(
      new Date(2026, 9, 1, 9, 0).getTime()
    )
  })

  it('wakes next Monday at 9 AM, skipping a week when today is Monday', () => {
    expect(resolveWorkspaceSnoozePresetWakeAt('next-week', wednesday)).toBe(
      new Date(2026, 9, 5, 9, 0).getTime()
    )
    const monday = new Date(2026, 9, 5, 8, 0)
    expect(resolveWorkspaceSnoozePresetWakeAt('next-week', monday)).toBe(
      new Date(2026, 9, 12, 9, 0).getTime()
    )
    const sunday = new Date(2026, 9, 4, 22, 0)
    expect(resolveWorkspaceSnoozePresetWakeAt('next-week', sunday)).toBe(
      new Date(2026, 9, 5, 9, 0).getTime()
    )
  })

  it('round-trips the datetime-local input value at minute precision', () => {
    const value = toDatetimeLocalValue(wednesday.getTime())
    expect(value).toBe('2026-09-30T15:20')
    expect(parseDatetimeLocalValue(value)).toBe(wednesday.getTime())
  })

  it('rejects an empty or invalid input value', () => {
    expect(parseDatetimeLocalValue('')).toBeNull()
    expect(parseDatetimeLocalValue('not a date')).toBeNull()
  })
})
