// "2 secrets missing · Add" in a cloud workspace's panel after the build sheet's Secrets row was skipped
// or left unfilled. Names only, per workspace, until filled or dismissed. Never a value.
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'orca.cloudSecretsMissing.v1'
const MAX_WORKSPACES = 200

export type CloudSecretsMissingNotice = {
  /** The names still missing when the person left the sheet. */
  names: string[]
  /** `github.com/owner/name`: the repo the values are for. */
  repoKey: string
  at: number
}

type Notices = Readonly<Record<string, CloudSecretsMissingNotice>>

let notices: Notices = read()
const listeners = new Set<() => void>()

function read(): Notices {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    const clean: Record<string, CloudSecretsMissingNotice> = {}
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (isNotice(value)) {
        clean[workspaceId] = value
      }
    }
    return clean
  } catch {
    return {}
  }
}

function isNotice(value: unknown): value is CloudSecretsMissingNotice {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('names' in value) ||
    !('repoKey' in value) ||
    !('at' in value)
  ) {
    return false
  }
  const { names, repoKey, at } = value
  return (
    Array.isArray(names) &&
    names.every((name) => typeof name === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(name)) &&
    typeof repoKey === 'string' &&
    typeof at === 'number'
  )
}

function write(next: Notices): void {
  // Oldest first out, so the record can't grow without bound.
  const entries = Object.entries(next).sort(([, a], [, b]) => b.at - a.at)
  notices = Object.fromEntries(entries.slice(0, MAX_WORKSPACES))
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(notices))
  } catch {
    // Storage full or unavailable: the notice still lives for this session.
  }
  for (const listener of listeners) {
    listener()
  }
}

export function recordCloudSecretsMissing(
  workspaceId: string,
  notice: Omit<CloudSecretsMissingNotice, 'at'>,
  now = Date.now()
): void {
  if (notice.names.length === 0) {
    clearCloudSecretsMissing(workspaceId)
    return
  }
  write({ ...notices, [workspaceId]: { ...notice, names: [...notice.names], at: now } })
}

/** Filled or dismissed. */
export function clearCloudSecretsMissing(workspaceId: string): void {
  if (!(workspaceId in notices)) {
    return
  }
  const { [workspaceId]: _removed, ...rest } = notices
  write(rest)
}

/** Some names were filled from elsewhere (the panel, Settings): keep only the rest. */
export function narrowCloudSecretsMissing(
  workspaceId: string,
  stillMissing: readonly string[]
): void {
  const current = notices[workspaceId]
  if (!current) {
    return
  }
  const names = current.names.filter((name) => stillMissing.includes(name))
  if (names.length === current.names.length) {
    return
  }
  if (names.length === 0) {
    clearCloudSecretsMissing(workspaceId)
  } else {
    write({ ...notices, [workspaceId]: { ...current, names } })
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCloudSecretsMissing(workspaceId: string): CloudSecretsMissingNotice | null {
  return useSyncExternalStore(
    subscribe,
    () => notices[workspaceId] ?? null,
    () => notices[workspaceId] ?? null
  )
}

export function readCloudSecretsMissing(workspaceId: string): CloudSecretsMissingNotice | null {
  return notices[workspaceId] ?? null
}

export function resetCloudSecretsMissingForTests(seed: Notices = {}): void {
  notices = seed
}
