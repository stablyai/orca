const MAX_PREFERENCES = 100
const MAX_STORAGE_LENGTH = 2 * 1024 * 1024

export function buildFileViewPreferenceKey(input: {
  worktreeId: string
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string | null
  filePath: string
}): string {
  return JSON.stringify([
    input.worktreeId,
    input.runtimeEnvironmentId?.trim() || 'local',
    input.externalSshTargetId?.trim() || null,
    input.filePath
  ])
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readPreferences(target: Storage, key: string): Record<string, unknown> {
  try {
    const raw = target.getItem(key)
    if (!raw || raw.length > MAX_STORAGE_LENGTH) {
      return {}
    }
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).slice(-MAX_PREFERENCES))
      : {}
  } catch {
    return {}
  }
}

export function readFileViewPreference(storageKey: string, fileKey: string): unknown {
  const target = storage()
  return target ? readPreferences(target, storageKey)[fileKey] : undefined
}

export function writeFileViewPreference(storageKey: string, fileKey: string, value: unknown): void {
  const target = storage()
  if (!target) {
    return
  }
  const preferences = readPreferences(target, storageKey)
  delete preferences[fileKey]
  preferences[fileKey] = value
  const keys = Object.keys(preferences)
  let serialized = JSON.stringify(preferences)
  while (keys.length > MAX_PREFERENCES || serialized.length > MAX_STORAGE_LENGTH) {
    const oldest = keys.shift()
    if (oldest === undefined) {
      return
    }
    delete preferences[oldest]
    serialized = JSON.stringify(preferences)
  }
  try {
    target.setItem(storageKey, serialized)
  } catch {
    // Preferences must not prevent using the viewer when storage is unavailable.
  }
}
