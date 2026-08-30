import type { PaneCommandIdentityEntry } from '../../store/slices/pane-command-identity'

/**
 * The two guards `createPaneCommandIdentitySlice` applies, so a test double
 * cannot accept a write or a clear the real store rejects.
 */
export function setPaneIdentity(
  store: Record<string, PaneCommandIdentityEntry>,
  paneKey: string,
  entry: PaneCommandIdentityEntry
): void {
  const current = store[paneKey]
  if (current?.ptyId === entry.ptyId && current.commandEpoch >= entry.commandEpoch) {
    return
  }
  store[paneKey] = entry
}

export function clearPaneIdentity(
  store: Record<string, PaneCommandIdentityEntry>,
  paneKey: string,
  ptyId?: string
): void {
  const current = store[paneKey]
  if (!current || (ptyId !== undefined && current.ptyId !== ptyId)) {
    return
  }
  delete store[paneKey]
}
