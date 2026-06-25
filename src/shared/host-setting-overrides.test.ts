import { describe, expect, it } from 'vitest'
import {
  clearHostSettingOverride,
  getEffectiveHostSetting,
  getHostDisplayLabelOverrides,
  getHostSettingOverride,
  setHostSettingOverride
} from './host-setting-overrides'
import type { GlobalSettings } from './types'

function settingsWith(
  overrides: GlobalSettings['hostSettingOverrides']
): Pick<GlobalSettings, 'hostSettingOverrides'> {
  return { hostSettingOverrides: overrides }
}

describe('getEffectiveHostSetting', () => {
  it('prefers a host override over the client default', () => {
    const settings = settingsWith({ 'ssh:box': { defaultWorktreeLocation: '/remote/work' } })
    expect(
      getEffectiveHostSetting(settings, 'ssh:box', 'defaultWorktreeLocation', '/local/work')
    ).toBe('/remote/work')
  })

  it('falls back to the client default when no override exists', () => {
    const settings = settingsWith({})
    expect(
      getEffectiveHostSetting(settings, 'ssh:box', 'defaultWorktreeLocation', '/local/work')
    ).toBe('/local/work')
  })

  it('falls back for an unknown host', () => {
    const settings = settingsWith({ 'ssh:other': { defaultWorktreeLocation: '/x' } })
    expect(
      getEffectiveHostSetting(settings, 'runtime:env', 'defaultWorktreeLocation', '/local/work')
    ).toBe('/local/work')
  })

  it('treats a whitespace override as absent and falls back', () => {
    const settings = settingsWith({ 'ssh:box': { defaultWorktreeLocation: '   ' } })
    expect(
      getEffectiveHostSetting(settings, 'ssh:box', 'defaultWorktreeLocation', '/local/work')
    ).toBe('/local/work')
  })

  it('allows local-host overrides', () => {
    const settings = settingsWith({ local: { defaultWorktreeLocation: '/local/override' } })
    expect(
      getEffectiveHostSetting(settings, 'local', 'defaultWorktreeLocation', '/local/work')
    ).toBe('/local/override')
  })

  it('falls back when settings are null/undefined', () => {
    expect(getEffectiveHostSetting(null, 'ssh:box', 'displayLabel', 'Default')).toBe('Default')
    expect(getEffectiveHostSetting(undefined, 'ssh:box', 'displayLabel', 'Default')).toBe('Default')
  })
})

describe('getHostSettingOverride', () => {
  it('returns the override when present', () => {
    const settings = settingsWith({ 'ssh:box': { displayLabel: 'My Box' } })
    expect(getHostSettingOverride(settings, 'ssh:box', 'displayLabel')).toBe('My Box')
  })

  it('returns undefined when missing', () => {
    expect(getHostSettingOverride(settingsWith({}), 'ssh:box', 'displayLabel')).toBeUndefined()
  })
})

describe('setHostSettingOverride', () => {
  it('adds an override for a new host', () => {
    const next = setHostSettingOverride(settingsWith({}), 'ssh:box', 'displayLabel', 'Box')
    expect(next).toEqual({ 'ssh:box': { displayLabel: 'Box' } })
  })

  it('merges into an existing host without clobbering other keys', () => {
    const settings = settingsWith({ 'ssh:box': { displayLabel: 'Box' } })
    const next = setHostSettingOverride(settings, 'ssh:box', 'defaultWorktreeLocation', '/w')
    expect(next).toEqual({ 'ssh:box': { displayLabel: 'Box', defaultWorktreeLocation: '/w' } })
  })

  it('does not mutate the input map', () => {
    const overrides = { 'ssh:box': { displayLabel: 'Box' } }
    const settings = settingsWith(overrides)
    setHostSettingOverride(settings, 'ssh:box', 'displayLabel', 'Renamed')
    expect(overrides).toEqual({ 'ssh:box': { displayLabel: 'Box' } })
  })

  it('clears the key when given an empty value', () => {
    const settings = settingsWith({
      'ssh:box': { displayLabel: 'Box', defaultWorktreeLocation: '/w' }
    })
    const next = setHostSettingOverride(settings, 'ssh:box', 'displayLabel', '  ')
    expect(next).toEqual({ 'ssh:box': { defaultWorktreeLocation: '/w' } })
  })
})

describe('clearHostSettingOverride', () => {
  it('removes a single key but keeps remaining overrides', () => {
    const settings = settingsWith({
      'ssh:box': { displayLabel: 'Box', defaultWorktreeLocation: '/w' }
    })
    expect(clearHostSettingOverride(settings, 'ssh:box', 'displayLabel')).toEqual({
      'ssh:box': { defaultWorktreeLocation: '/w' }
    })
  })

  it('drops the host entry when no overrides remain', () => {
    const settings = settingsWith({ 'ssh:box': { displayLabel: 'Box' } })
    expect(clearHostSettingOverride(settings, 'ssh:box', 'displayLabel')).toEqual({})
  })

  it('is a no-op for an unknown host', () => {
    const settings = settingsWith({ 'ssh:other': { displayLabel: 'Other' } })
    expect(clearHostSettingOverride(settings, 'ssh:box', 'displayLabel')).toEqual({
      'ssh:other': { displayLabel: 'Other' }
    })
  })

  it('does not mutate the input map', () => {
    const overrides = { 'ssh:box': { displayLabel: 'Box' } }
    const settings = settingsWith(overrides)
    clearHostSettingOverride(settings, 'ssh:box', 'displayLabel')
    expect(overrides).toEqual({ 'ssh:box': { displayLabel: 'Box' } })
  })
})

describe('getHostDisplayLabelOverrides', () => {
  it('collects non-empty display labels keyed by host id', () => {
    const settings = settingsWith({
      'ssh:box': { displayLabel: 'Box' },
      'runtime:env': { defaultWorktreeLocation: '/w' },
      local: { displayLabel: '  ' }
    })
    const map = getHostDisplayLabelOverrides(settings)
    expect(map.get('ssh:box')).toBe('Box')
    expect(map.has('runtime:env')).toBe(false)
    expect(map.has('local')).toBe(false)
  })

  it('returns an empty map when no overrides exist', () => {
    expect(getHostDisplayLabelOverrides(null).size).toBe(0)
  })
})
