import { describe, expect, it } from 'vitest'
import { RENDERER_DENIED_SETTINGS_KEYS } from '../../../main/ipc/settings/renderer-settings-update'
import { PROTECTED_SECRET_SLOT } from '../../../main/credentials/protected-secret-persistence'
import { getDefaultSettings } from '../../orca-profiles/constants'
import { SETTINGS_KEYS_NAMING_A_PATH } from '../../wsl-move/wsl-move-ui-dispositions'
import type { GlobalSettings } from '../global-settings-types'
import { isValidPortableSettingValue } from './portable-setting-validation'
import { PORTABLE_SETTINGS_KEYS, SETTINGS_KEY_PORTABILITY } from './settings-key-portability'

const SETTINGS_SLOT_PREFIX = 'settings.'

// Denied outright by the sanitizer, plus the two it only partly guards (telemetry fields, reauth flag type).
const RENDERER_GUARDED_KEYS = [
  ...RENDERER_DENIED_SETTINGS_KEYS,
  'telemetry',
  'browserPasswordsFillRequiresReauth'
] as const satisfies readonly (keyof GlobalSettings)[]

const COMMAND_BEARING_KEYS = [
  'agentCmdOverrides',
  'agentDefaultArgs',
  'agentDefaultEnv',
  'terminalDefaultShell'
] as const satisfies readonly (keyof GlobalSettings)[]

describe('settings key portability', () => {
  it('classifies every encrypted-at-rest settings slot as private', () => {
    const slotKeys = Object.values(PROTECTED_SECRET_SLOT)
      .filter((slot) => slot.startsWith(SETTINGS_SLOT_PREFIX))
      .map((slot) => slot.slice(SETTINGS_SLOT_PREFIX.length))

    expect(slotKeys.length).toBeGreaterThan(0)
    for (const key of slotKeys) {
      expect(SETTINGS_KEY_PORTABILITY).toHaveProperty(key, 'private')
    }
  })

  it('keeps every key that names a filesystem path out of the portable set', () => {
    for (const key of Object.keys(SETTINGS_KEYS_NAMING_A_PATH)) {
      expect(PORTABLE_SETTINGS_KEYS).not.toContain(key)
    }
  })

  it('keeps command, env, args and renderer-denylisted keys out of the portable set', () => {
    for (const key of [...COMMAND_BEARING_KEYS, ...RENDERER_GUARDED_KEYS]) {
      expect(PORTABLE_SETTINGS_KEYS).not.toContain(key)
    }
  })

  it('only marks keys portable whose default is a primitive', () => {
    const defaults: Partial<Record<keyof GlobalSettings, unknown>> = getDefaultSettings('/home/u')

    for (const key of PORTABLE_SETTINGS_KEYS) {
      const value = defaults[key]
      const isPrimitiveOrUnset =
        value === undefined ||
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'number' ||
        typeof value === 'string'
      expect({ key, isPrimitiveOrUnset }).toEqual({ key, isPrimitiveOrUnset: true })
    }
  })

  it('accepts the default of every portable key it can hold', () => {
    const defaults: Partial<Record<keyof GlobalSettings, unknown>> = getDefaultSettings('/home/u')

    for (const key of PORTABLE_SETTINGS_KEYS) {
      if (defaults[key] === undefined) {
        continue
      }
      const accepted = isValidPortableSettingValue(key, defaults[key])
      expect({ key, accepted }).toEqual({ key, accepted: true })
    }
  })

  it('validates values by the key spec', () => {
    expect(isValidPortableSettingValue('terminalInlineImages', true)).toBe(true)
    expect(isValidPortableSettingValue('terminalInlineImages', 'true')).toBe(false)
    expect(isValidPortableSettingValue('terminalFontSize', 14)).toBe(true)
    expect(isValidPortableSettingValue('terminalFontSize', Number.NaN)).toBe(false)
    expect(isValidPortableSettingValue('terminalFontFamily', 'Menlo')).toBe(true)
    expect(isValidPortableSettingValue('terminalFontFamily', 3)).toBe(false)
    expect(isValidPortableSettingValue('theme', 'dark')).toBe(true)
    expect(isValidPortableSettingValue('theme', 'neon')).toBe(false)
    expect(isValidPortableSettingValue('uiLanguage', 'plugin:acme.pack/fr')).toBe(true)
    expect(isValidPortableSettingValue('uiLanguage', 'ko')).toBe(true)
    expect(isValidPortableSettingValue('uiLanguage', 'xx')).toBe(false)
    expect(isValidPortableSettingValue('uiLanguage', 'plugin:acme.fr')).toBe(false)
  })

  it('accepts null only for keys whose type includes null and never accepts undefined', () => {
    expect(isValidPortableSettingValue('defaultTuiAgent', null)).toBe(true)
    expect(isValidPortableSettingValue('mobileAutoRestoreFitMs', null)).toBe(true)
    expect(isValidPortableSettingValue('theme', null)).toBe(false)
    expect(isValidPortableSettingValue('terminalFontSize', undefined)).toBe(false)
  })

  it('rejects keys that are not portable', () => {
    expect(isValidPortableSettingValue('activeRuntimeEnvironmentId', 'env')).toBe(false)
    expect(isValidPortableSettingValue('terminalDefaultShell', 'zsh')).toBe(false)
  })
})
