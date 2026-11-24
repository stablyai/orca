export type IgnoredSettingsKey = {
  key: string
  reason: 'not-portable' | 'invalid-value' | 'unknown'
}

export type SettingsFileState = 'absent' | 'active' | 'invalid' | 'read-only'

export type SettingsFileStatus = {
  state: SettingsFileState
  path: string
  appliedKeyCount: number
  ignored: IgnoredSettingsKey[]
  message?: string
}

export type SettingsFileSyncSettings = {
  /** Portable keys present in ~/.orca/settings.json at its last read; a key that later disappears resets to its default. */
  settingsFileLastSeenKeys?: string[]
}
