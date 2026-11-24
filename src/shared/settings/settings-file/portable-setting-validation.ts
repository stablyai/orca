import type { GlobalSettings } from '../global-settings-types'
import type { PortableValueSpec } from './portable-setting-spec'
import { PORTABLE_KEY_SPECS, PORTABLE_NULLABLE_KEYS } from './portable-settings-keys'

export type PortableSettingsKey = keyof typeof PORTABLE_KEY_SPECS

export function isPortableSettingsKey(key: string): key is PortableSettingsKey {
  return Object.hasOwn(PORTABLE_KEY_SPECS, key)
}

function matchesSpec(spec: PortableValueSpec, value: unknown): boolean {
  if (typeof spec === 'function') {
    return spec(value)
  }
  if (spec === 'boolean') {
    return typeof value === 'boolean'
  }
  if (spec === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
  }
  if (spec === 'string') {
    return typeof value === 'string'
  }
  return typeof value === 'string' && spec.includes(value)
}

// undefined is never valid: it cannot be represented in the JSON file.
export function isValidPortableSettingValue(key: keyof GlobalSettings, value: unknown): boolean {
  if (!isPortableSettingsKey(key)) {
    return false
  }
  if (value === null) {
    return Object.hasOwn(PORTABLE_NULLABLE_KEYS, key)
  }
  return matchesSpec(PORTABLE_KEY_SPECS[key], value)
}
