// The clone parent is remembered so reopening Add Project → Clone from URL starts where the last
// pick left off: the dialog clears its own state on close, so this has to outlive it.

const STORAGE_KEY = 'orca.add-repo.clone-parent-folder'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readAll(storage: StorageLike): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''
      )
    )
  } catch {
    return {}
  }
}

export function cloneParentTargetKey(
  activeRuntimeEnvironmentId: string | null | undefined
): string {
  const runtimeEnvironmentId = activeRuntimeEnvironmentId?.trim()
  return runtimeEnvironmentId ? `runtime:${runtimeEnvironmentId}` : 'local'
}

/** The folder picked for this target last time, or '' when there is none. */
export function readCloneParentFolder(
  targetKey: string,
  storage: StorageLike | null = defaultStorage()
): string {
  return storage ? (readAll(storage)[targetKey] ?? '') : ''
}

/** Remembers a picked folder for this target; an empty folder forgets it. */
export function writeCloneParentFolder(
  targetKey: string,
  folder: string,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage) {
    return
  }
  const entries = readAll(storage)
  delete entries[targetKey]
  const trimmed = folder.trim()
  if (trimmed) {
    entries[targetKey] = trimmed
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Storage can be unavailable (quota, private mode); the field still holds this session's value.
  }
}
