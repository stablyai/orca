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
