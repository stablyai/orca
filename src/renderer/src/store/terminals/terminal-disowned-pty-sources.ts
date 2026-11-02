import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/** Only reachable relay’s exact-ID disown reply permits retiring binding/respawning; it is weaker than exited (restarted relays forget IDs) and may leak old processes. Lost links/timeouts/mismatches remain unverifiable (ssh-execution-boundary.md). Session-only. */
export function createTerminalDisownedPtySourceActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'markPtySourceDisowned'> {
  return {
    markPtySourceDisowned: (ptyId) => {
      set((state) =>
        state.disownedPtyIds[ptyId]
          ? state
          : { disownedPtyIds: { ...state.disownedPtyIds, [ptyId]: true } }
      )
    }
  }
}

/** Removes settled ids without allocating when none is recorded. */
export function omitDisownedPtyIds(
  records: Readonly<Record<string, true>>,
  ptyIds: Iterable<string>
): Record<string, true> {
  let next: Record<string, true> | null = null
  for (const ptyId of ptyIds) {
    if (!records[ptyId]) {
      continue
    }
    next ??= { ...records }
    delete next[ptyId]
  }
  return next ?? records
}
