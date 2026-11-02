import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/**
 * Session-scoped record of PTY ids a reachable relay disowned.
 *
 * Main raises it solely on the branch where the relay replied about that exact id, never on a lost
 * link, a timeout or an identity mismatch (docs/reference/ssh-execution-boundary.md). It is not
 * `exited` — a restarted relay disowns ids it never minted — but it is the only signal strong
 * enough to let a reconnect retire the binding and respawn, which leaks the old process rather than
 * killing it. Every other absence signal the client holds is `unverifiable` and licenses nothing.
 */
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
