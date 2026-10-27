import type { GlobalSettings } from '../global-settings-types'
import {
  SETTINGS_BACKUP_DEVICE_BOUND_NESTED_FIELDS,
  getSettingsBackupKeyClass,
  listSettingsBackupKeys,
  type SettingsBackupSectionId
} from './settings-backup-catalog'
import { areJsonValuesEqual, isPlainJsonValue } from './settings-backup-canonical-json'
import { containsSecretLikeValue } from './settings-backup-secret-scan'
import type { SettingsBackupDiffEntry } from './settings-backup-types'

export type SettingsBackupProjection = {
  settings: Partial<GlobalSettings>
  excludedSecretKeys: string[]
}

/** Picks the exportable settings for the chosen sections, dropping machine-bound and secret-like data. */
export function projectSettingsForBackup(
  settings: GlobalSettings,
  sections: readonly SettingsBackupSectionId[]
): SettingsBackupProjection {
  const projected: Record<string, unknown> = {}
  const excludedSecretKeys: string[] = []
  for (const key of listSettingsBackupKeys(sections)) {
    const value: unknown = settings[key]
    if (value === undefined || !isPlainJsonValue(value)) {
      continue
    }
    const exported = omitDeviceBoundFields(key, value)
    if (containsSecretLikeValue(exported)) {
      excludedSecretKeys.push(key)
      continue
    }
    projected[key] = structuredClone(exported)
  }
  return { settings: projected, excludedSecretKeys }
}

export type SettingsBackupDiff = {
  entries: SettingsBackupDiffEntry[]
  unchangedKeyCount: number
}

/** Compares a backup against the live settings; nothing here writes, it only decides what could. */
export function diffSettingsBackup(args: {
  current: GlobalSettings
  incoming: Record<string, unknown>
  sourcePlatform: NodeJS.Platform
  currentPlatform: NodeJS.Platform
}): SettingsBackupDiff {
  const currentByKey = new Map<string, unknown>(Object.entries(args.current))
  const entries: SettingsBackupDiffEntry[] = []
  let unchangedKeyCount = 0
  for (const [key, rawIncoming] of Object.entries(args.incoming)) {
    const keyClass = getSettingsBackupKeyClass(key)
    const currentValue = currentByKey.get(key)
    const section =
      keyClass === null || keyClass === 'protected' || keyClass === 'internal' ? null : keyClass
    const blocked = (skipReason: SettingsBackupDiffEntry['skipReason']): void => {
      entries.push({
        key,
        section,
        kind: currentValue === undefined ? 'added' : 'changed',
        currentValue: section === null ? undefined : currentValue,
        incomingValue: undefined,
        skipReason,
        applicable: false
      })
    }
    if (keyClass === null) {
      blocked('unsupported-key')
      continue
    }
    if (section === null) {
      blocked('protected-key')
      continue
    }
    if (!isCompatibleValueShape(currentValue, rawIncoming)) {
      blocked('invalid-value')
      continue
    }
    if (containsSecretLikeValue(rawIncoming)) {
      blocked('secret-like-value')
      continue
    }
    const incomingValue = keepDeviceBoundFields(key, rawIncoming, currentValue)
    if (areJsonValuesEqual(currentValue, incomingValue)) {
      unchangedKeyCount += 1
      continue
    }
    entries.push({
      key,
      section,
      kind: currentValue === undefined ? 'added' : 'changed',
      currentValue,
      incomingValue,
      ...(section === 'device' && args.sourcePlatform !== args.currentPlatform
        ? { skipReason: 'other-platform' as const }
        : {}),
      applicable: true
    })
  }
  return { entries, unchangedKeyCount }
}

/** Builds the settings update for the keys the user confirmed; blocked entries can never slip through. */
export function buildSettingsBackupUpdate(
  entries: readonly SettingsBackupDiffEntry[],
  selectedKeys: readonly string[]
): Partial<GlobalSettings> {
  const selected = new Set(selectedKeys)
  const update: Record<string, unknown> = {}
  for (const entry of entries) {
    if (entry.applicable && selected.has(entry.key)) {
      update[entry.key] = structuredClone(entry.incomingValue)
    }
  }
  return update
}

/** Entries pre-selected in the import review: everything applicable that needs no extra opt-in. */
export function defaultSelectedSettingsBackupKeys(
  entries: readonly SettingsBackupDiffEntry[]
): string[] {
  return entries.filter((entry) => entry.applicable && !entry.skipReason).map((entry) => entry.key)
}

function isCompatibleValueShape(current: unknown, incoming: unknown): boolean {
  if (!isPlainJsonValue(incoming)) {
    return false
  }
  if (current === undefined || current === null) {
    return true
  }
  if (incoming === null) {
    return false
  }
  if (Array.isArray(current) || Array.isArray(incoming)) {
    return Array.isArray(current) && Array.isArray(incoming)
  }
  return typeof current === typeof incoming
}

function omitDeviceBoundFields(key: keyof GlobalSettings, value: unknown): unknown {
  const fields = SETTINGS_BACKUP_DEVICE_BOUND_NESTED_FIELDS[key]
  if (!fields || !isPlainObject(value)) {
    return value
  }
  return Object.fromEntries(Object.entries(value).filter(([field]) => !fields.includes(field)))
}

function keepDeviceBoundFields(key: string, incoming: unknown, current: unknown): unknown {
  const fields = Object.entries(SETTINGS_BACKUP_DEVICE_BOUND_NESTED_FIELDS).find(
    ([candidate]) => candidate === key
  )?.[1]
  if (!fields || !isPlainObject(incoming)) {
    return incoming
  }
  const merged = Object.fromEntries(
    Object.entries(incoming).filter(([field]) => !fields.includes(field))
  )
  if (isPlainObject(current)) {
    for (const [field, value] of Object.entries(current)) {
      if (fields.includes(field)) {
        merged[field] = value
      }
    }
  }
  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
