import { describe, expect, it } from 'vitest'
import {
  computerAwakeSettingsForMacosEngine,
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode,
  normalizeMacosAwakeEngine
} from './computer-awake-mode'

describe('computer awake mode', () => {
  it('maps the legacy enabled setting to Auto', () => {
    expect(normalizeComputerAwakeMode(undefined, true)).toBe('auto')
    expect(normalizeComputerAwakeMode(undefined, false)).toBe('off')
  })

  it('preserves explicit modes when the legacy projection agrees or is absent', () => {
    expect(normalizeComputerAwakeMode('on')).toBe('on')
    expect(normalizeComputerAwakeMode('on', true)).toBe('on')
    expect(normalizeComputerAwakeMode('off', false)).toBe('off')
    expect(normalizeComputerAwakeMode('auto', true)).toBe('auto')
  })

  it('honors legacy changes made by a rollback build', () => {
    expect(normalizeComputerAwakeMode('on', false)).toBe('off')
    expect(normalizeComputerAwakeMode('auto', false)).toBe('off')
    expect(normalizeComputerAwakeMode('off', true)).toBe('auto')
  })

  it('writes a safe legacy approximation', () => {
    expect(computerAwakeSettingsForMode('on')).toEqual({
      computerAwakeMode: 'on',
      keepComputerAwakeWhileAgentsRun: true
    })
    expect(computerAwakeSettingsForMode('off')).toEqual({
      computerAwakeMode: 'off',
      keepComputerAwakeWhileAgentsRun: false
    })
  })

  it('normalizes the persisted macOS integration preference', () => {
    expect(normalizeMacosAwakeEngine('amphetamine')).toBe('amphetamine')
    expect(normalizeMacosAwakeEngine('caffeinate')).toBe('caffeinate')
    expect(normalizeMacosAwakeEngine(undefined)).toBe('caffeinate')
    expect(normalizeMacosAwakeEngine('unknown')).toBe('caffeinate')
  })

  it('writes the compatible macOS integration field', () => {
    expect(computerAwakeSettingsForMacosEngine('amphetamine')).toEqual({
      computerAwakeMacosEngine: 'amphetamine'
    })
    expect(computerAwakeSettingsForMacosEngine('caffeinate')).toEqual({
      computerAwakeMacosEngine: 'caffeinate'
    })
  })
})
