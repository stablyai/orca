// Home's three list switches (Running, Archived, Routine runs) are remembered per signed-in account
// (user and team) on this desktop. Preferences only: they never decide access, so local storage is enough.
const KEY = 'orca.cloudWorkspacesHome.switches'

export type HomeSwitches = { running: boolean; archived: boolean; routines: boolean }
const OFF: HomeSwitches = { running: false, archived: false, routines: false }

function read(storage: Storage | undefined): Record<string, Partial<HomeSwitches>> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, Partial<HomeSwitches>> = {}
    for (const [account, saved] of Object.entries(parsed)) {
      if (saved && typeof saved === 'object') {
        const flags: Record<string, unknown> = { ...saved }
        out[account] = {
          running: flags.running === true,
          archived: flags.archived === true,
          routines: flags.routines === true
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

export function readHomeSwitches(
  account: string,
  storage: Storage | undefined = globalThis.localStorage
): HomeSwitches {
  const saved = read(storage)[account] ?? {}
  return {
    running: saved.running === true,
    archived: saved.archived === true,
    routines: saved.routines === true
  }
}

export function writeHomeSwitches(
  account: string,
  next: Partial<HomeSwitches>,
  storage: Storage | undefined = globalThis.localStorage
): void {
  const all = read(storage)
  const merged = { ...OFF, ...readHomeSwitches(account, storage), ...next }
  if (!merged.running && !merged.archived && !merged.routines) {
    delete all[account]
  } else {
    all[account] = merged
  }
  try {
    storage?.setItem(KEY, JSON.stringify(all))
  } catch {
    // Storage full or unavailable: the switches still work for this session.
  }
}
