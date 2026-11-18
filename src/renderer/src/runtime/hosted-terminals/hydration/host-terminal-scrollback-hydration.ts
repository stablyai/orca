import {
  defaultDeps,
  planHostScrollbackHydration,
  fetchHostScrollback,
  HOST_TERMINAL_SCROLLBACK_HOLD_MS,
  resetHostTerminalScrollbackReadsForTests,
  type HostTerminalScrollbackHydrationDeps,
  type LocalScrollbackSnapshots
} from './host-terminal-scrollback-reads'

export {
  HOST_TERMINAL_SCROLLBACK_HOLD_MS,
  hostScrollbackEnvironmentId
} from './host-terminal-scrollback-reads'
export type {
  HostTerminalScrollbackHydrationDeps,
  HostTerminalScrollbackTabState,
  LocalScrollbackSnapshots
} from './host-terminal-scrollback-reads'

export type TerminalScrollbackHydrationAttempt = {
  local: Promise<boolean>
  ready: Promise<LocalScrollbackSnapshots>
  retire: () => void
}

const localReads = new Map<string, Promise<string | null>>()

function readLocal(
  key: string,
  ref: string,
  deps: HostTerminalScrollbackHydrationDeps
): Promise<string | null> {
  const pending = localReads.get(key)
  if (pending) {
    return pending
  }
  const read = Promise.resolve()
    .then(() => deps.readLocalSnapshot(ref))
    .catch(() => null)
    .finally(() => {
      if (localReads.get(key) === read) {
        localReads.delete(key)
      }
    })
  localReads.set(key, read)
  return read
}

/** Each manager mount acquires current bytes; retiring a consumer never drains another's result. */
export function startHostTerminalScrollbackHydration(
  tabId: string,
  worktreeId: string,
  deps: HostTerminalScrollbackHydrationDeps = defaultDeps,
  isCurrent: () => boolean = () => true,
  commit?: (snapshots: LocalScrollbackSnapshots) => void
): TerminalScrollbackHydrationAttempt | null {
  const missingLeaves = () => {
    const { layout, localOnly } = deps.getTabState(tabId)
    return Object.entries(layout?.scrollbackRefsByLeafId ?? {}).filter(
      ([leafId]) =>
        layout?.buffersByLeafId?.[leafId] === undefined && localOnly?.[leafId] === undefined
    )
  }
  if (missingLeaves().length === 0) {
    return null
  }
  const retirement = new AbortController()
  const current = (): boolean => !retirement.signal.aborted && isCurrent()
  let snapshots: LocalScrollbackSnapshots = {}
  const attempted = new Map<string, string>()
  let hostDeadline: number | undefined
  const unattemptedLeaves = () =>
    missingLeaves().filter(([leafId, ref]) => attempted.get(leafId) !== ref)
  const readCurrentLocal = async (): Promise<void> => {
    while (current()) {
      const leaves = unattemptedLeaves()
      if (leaves.length === 0) {
        return
      }
      for (const [leafId, ref] of leaves) {
        if (!current()) {
          return
        }
        const state = deps.getTabState(tabId)
        if (
          state.layout?.scrollbackRefsByLeafId?.[leafId] !== ref ||
          state.layout.buffersByLeafId?.[leafId] !== undefined ||
          state.localOnly?.[leafId] !== undefined
        ) {
          continue
        }
        const buffer = await readLocal(`${worktreeId}\0${tabId}\0${ref}`, ref, deps)
        if (!current()) {
          return
        }
        attempted.set(leafId, ref)
        if (buffer) {
          snapshots[leafId] = { ref, buffer }
        }
      }
    }
  }
  const local = Promise.resolve().then(async () => {
    await readCurrentLocal()
    return current() && planHostScrollbackHydration(tabId, worktreeId, deps, snapshots) !== null
  })
  const ready = local.then(async () => {
    while (current()) {
      await readCurrentLocal()
      if (!current()) {
        break
      }
      const plan = planHostScrollbackHydration(tabId, worktreeId, deps, snapshots)
      if (plan) {
        hostDeadline ??= Date.now() + HOST_TERMINAL_SCROLLBACK_HOLD_MS
        const remaining = hostDeadline - Date.now()
        if (remaining > 0) {
          await fetchHostScrollback(
            tabId,
            worktreeId,
            plan,
            deps,
            current,
            retirement.signal,
            remaining
          )
        }
      }
      if (!current()) {
        break
      }
      if (unattemptedLeaves().length > 0) {
        continue
      }
      // No promise gap between the final ref validation and synchronous mount preparation.
      if (commit) {
        commit(snapshots)
        snapshots = {}
      }
      return snapshots
    }
    snapshots = {}
    return {}
  })
  return {
    local,
    ready,
    retire: () => {
      retirement.abort()
      snapshots = {}
    }
  }
}

export function resetHostTerminalScrollbackHydrationForTests(): void {
  localReads.clear()
  resetHostTerminalScrollbackReadsForTests()
}
