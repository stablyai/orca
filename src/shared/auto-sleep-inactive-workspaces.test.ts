import { describe, expect, it } from 'vitest'
import {
  AUTO_SLEEP_INACTIVE_WORKSPACE_PRESETS,
  autoSleepMsFromPresetValue,
  autoSleepPresetValueFromMs
} from './auto-sleep-inactive-workspaces'

describe('auto-sleep inactive workspace presets', () => {
  it('maps known millisecond values to preset keys', () => {
    expect(autoSleepPresetValueFromMs(30 * 60_000)).toBe('30m')
    expect(autoSleepPresetValueFromMs(60 * 60_000)).toBe('1h')
    expect(autoSleepPresetValueFromMs(null)).toBe('off')
    expect(autoSleepPresetValueFromMs(undefined)).toBe('off')
  })

  it('falls back to off for unknown millisecond values', () => {
    expect(autoSleepPresetValueFromMs(99_000)).toBe('off')
  })

  it('maps preset keys back to milliseconds', () => {
    expect(autoSleepMsFromPresetValue('30m')).toBe(30 * 60_000)
    expect(autoSleepMsFromPresetValue('off')).toBeNull()
    expect(autoSleepMsFromPresetValue('unknown')).toBeNull()
  })

  it('defaults new repos to off', () => {
    expect(AUTO_SLEEP_INACTIVE_WORKSPACE_PRESETS[0]).toEqual({
      value: 'off',
      label: 'Off',
      ms: null
    })
  })
})
