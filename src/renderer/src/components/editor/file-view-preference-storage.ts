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
  savePreferences(target, storageKey, preferences)
}

/**
 * Adds each re-keyed preference beside its source, at the same recency. A full store makes room by
 * dropping copied sources, oldest first, never another file's. Throws when storage refuses the write.
 */
export function copyFileViewPreferences(
  storageKey: string,
  copyKeyOf: (fileKey: string) => string | null
): boolean {
  const target = storage()
  if (!target) {
    return false
  }
  const preferences = readPreferences(target, storageKey)
  const next: Record<string, unknown> = {}
  const copiedSources: string[] = []
  for (const [fileKey, value] of Object.entries(preferences)) {
    next[fileKey] = value
    const copy = copyKeyOf(fileKey)
    if (copy !== null && !Object.hasOwn(preferences, copy) && !Object.hasOwn(next, copy)) {
      next[copy] = value
      copiedSources.push(fileKey)
    }
  }
  if (copiedSources.length === 0) {
    return false
  }
  for (const source of copiedSources) {
    if (
      Object.keys(next).length <= MAX_PREFERENCES &&
      JSON.stringify(next).length <= MAX_STORAGE_LENGTH
    ) {
      break
    }
    delete next[source]
  }
  if (!savePreferences(target, storageKey, next)) {
    throw new Error('file_view_preferences_not_saved')
  }
  return true
}

function savePreferences(
  target: Storage,
  storageKey: string,
  preferences: Record<string, unknown>
): boolean {
  const keys = Object.keys(preferences)
  let serialized = JSON.stringify(preferences)
  while (keys.length > MAX_PREFERENCES || serialized.length > MAX_STORAGE_LENGTH) {
    const oldest = keys.shift()
    if (oldest === undefined) {
      return false
    }
    delete preferences[oldest]
    serialized = JSON.stringify(preferences)
  }
  try {
    target.setItem(storageKey, serialized)
    return true
  } catch {
    // Preferences must not prevent using the viewer when storage is unavailable.
    return false
  }
}
