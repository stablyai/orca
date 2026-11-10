// Where new workspaces run by default: each project's last successful start target, a global last
// choice, and the per-project "Default run on" setting. Written only after a successful start, so a
// refused or canceled Orca Cloud attempt never becomes the default. Per Orca profile, on this device.
import type { RunOnPreference } from '@/components/new-workspace/run-on/cloud-start-model'

export type RunOnTarget = 'local' | 'orca-cloud'

type RunOnMemory = {
  lastByRepo: Record<string, RunOnTarget>
  globalLast: RunOnTarget | null
  preferenceByRepo: Record<string, RunOnPreference>
}

const KEY_PREFIX = 'orca.runOn.v1'
/** Bounded so a long-lived profile can't grow the record without limit. */
const MAX_REPOS = 200

function storageKey(profileId: string | null): string {
  return `${KEY_PREFIX}:${profileId ?? 'default'}`
}

function empty(): RunOnMemory {
  return { lastByRepo: {}, globalLast: null, preferenceByRepo: {} }
}

const isTarget = (value: unknown): value is RunOnTarget =>
  value === 'local' || value === 'orca-cloud'
const isPreference = (value: unknown): value is RunOnPreference =>
  value === 'last' || isTarget(value)

function read(profileId: string | null, storage: Storage | undefined): RunOnMemory {
  try {
    const raw = storage?.getItem(storageKey(profileId))
    if (!raw) {
      return empty()
    }
    const parsed = JSON.parse(raw) as Partial<RunOnMemory>
    const memory = empty()
    for (const [repoId, target] of Object.entries(parsed.lastByRepo ?? {})) {
      if (isTarget(target)) {
        memory.lastByRepo[repoId] = target
      }
    }
    for (const [repoId, preference] of Object.entries(parsed.preferenceByRepo ?? {})) {
      if (isPreference(preference)) {
        memory.preferenceByRepo[repoId] = preference
      }
    }
    memory.globalLast = isTarget(parsed.globalLast) ? parsed.globalLast : null
    return memory
  } catch {
    return empty()
  }
}

function write(profileId: string | null, memory: RunOnMemory, storage: Storage | undefined): void {
  const repoIds = Object.keys(memory.lastByRepo)
  if (repoIds.length > MAX_REPOS) {
    for (const repoId of repoIds.slice(0, repoIds.length - MAX_REPOS)) {
      delete memory.lastByRepo[repoId]
    }
  }
  try {
    storage?.setItem(storageKey(profileId), JSON.stringify(memory))
  } catch {
    // Quota or private mode: the default just falls back to this computer next time.
  }
}

function defaultStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/** Call only after a workspace actually started on `target`. */
export function recordSuccessfulRunOn(
  profileId: string | null,
  repoId: string,
  target: RunOnTarget,
  storage: Storage | undefined = defaultStorage()
): void {
  const memory = read(profileId, storage)
  // Re-insert so the most recent repos survive the bound.
  delete memory.lastByRepo[repoId]
  memory.lastByRepo[repoId] = target
  memory.globalLast = target
  write(profileId, memory, storage)
}

export function readRunOnMemory(
  profileId: string | null,
  repoId: string,
  storage: Storage | undefined = defaultStorage()
): {
  preference: RunOnPreference
  lastForRepo: RunOnTarget | null
  globalLast: RunOnTarget | null
} {
  const memory = read(profileId, storage)
  return {
    preference: memory.preferenceByRepo[repoId] ?? 'last',
    lastForRepo: memory.lastByRepo[repoId] ?? null,
    globalLast: memory.globalLast
  }
}

export function setRunOnPreference(
  profileId: string | null,
  repoId: string,
  preference: RunOnPreference,
  storage: Storage | undefined = defaultStorage()
): void {
  const memory = read(profileId, storage)
  if (preference === 'last') {
    delete memory.preferenceByRepo[repoId]
  } else {
    memory.preferenceByRepo[repoId] = preference
  }
  write(profileId, memory, storage)
}
