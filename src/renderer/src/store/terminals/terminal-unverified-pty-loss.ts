import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/** Session-scoped protection for tabs whose host disappeared before an exit was proven. */
export function createTerminalUnverifiedPtyLossActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'markUnverifiedPtyLoss'> {
  return {
    markUnverifiedPtyLoss: (tabId) => {
      set((state) =>
        state.unverifiedPtyLossTabIds[tabId]
          ? {}
          : { unverifiedPtyLossTabIds: { ...state.unverifiedPtyLossTabIds, [tabId]: true } }
      )
    }
  }
}

/** Removes settled markers without allocating when no marker is present. */
export function omitUnverifiedPtyLossTabIds(
  markers: Readonly<Record<string, true>>,
  tabIds: Iterable<string>
): Record<string, true> {
  let next: Record<string, true> | null = null
  for (const tabId of tabIds) {
    if (!markers[tabId]) {
      continue
    }
    next ??= { ...markers }
    delete next[tabId]
  }
  return next ?? markers
}

/** Keeps only markers whose tab rows survived a complete session hydration. */
export function retainUnverifiedPtyLossTabIds(
  markers: Readonly<Record<string, true>>,
  validTabIds: ReadonlySet<string>
): Record<string, true> {
  let next: Record<string, true> | null = null
  for (const tabId of Object.keys(markers)) {
    if (validTabIds.has(tabId)) {
      continue
    }
    next ??= { ...markers }
    delete next[tabId]
  }
  return next ?? markers
}
