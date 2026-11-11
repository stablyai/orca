// Home's Routine runs switch is remembered per signed-in account (user and team) on this desktop.
// A preference only: it never decides access, so local storage is enough.
const KEY = 'orca.cloudWorkspacesHome.showRoutineRuns'

function read(storage: Storage | undefined): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {}
  } catch {
    return {}
  }
}

export function readShowRoutineRuns(
  account: string,
  storage: Storage | undefined = globalThis.localStorage
): boolean {
  return read(storage)[account] === true
}

export function writeShowRoutineRuns(
  account: string,
  on: boolean,
  storage: Storage | undefined = globalThis.localStorage
): void {
  const all = read(storage)
  if (on) {
    all[account] = true
  } else {
    delete all[account]
  }
  try {
    storage?.setItem(KEY, JSON.stringify(all))
  } catch {
    // Storage full or unavailable: the switch still works for this session.
  }
}
