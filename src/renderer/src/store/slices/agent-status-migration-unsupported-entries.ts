import type { MigrationUnsupportedPtyEntry } from '../../../../shared/agent-status-types'

export function pruneMigrationUnsupportedEntries(
  entries: Record<string, MigrationUnsupportedPtyEntry>,
  predicate: (entry: MigrationUnsupportedPtyEntry) => boolean
): { next: Record<string, MigrationUnsupportedPtyEntry>; changed: boolean } {
  let changed = false
  const next: Record<string, MigrationUnsupportedPtyEntry> = {}
  for (const [ptyId, entry] of Object.entries(entries)) {
    if (predicate(entry)) {
      changed = true
      continue
    }
    next[ptyId] = entry
  }
  return { next: changed ? next : entries, changed }
}

/** Re-points entries of a moved pane at its new key and tab, so the source-tab sweep keeps them. */
export function rekeyMigrationUnsupportedEntries(
  entries: Record<string, MigrationUnsupportedPtyEntry>,
  predicate: (entry: MigrationUnsupportedPtyEntry) => boolean,
  toPaneKey: string,
  toTabId: string | undefined,
  toLeafId: string | undefined
): Record<string, MigrationUnsupportedPtyEntry> {
  let next: Record<string, MigrationUnsupportedPtyEntry> | null = null
  for (const [ptyId, entry] of Object.entries(entries)) {
    if (predicate(entry)) {
      next ??= { ...entries }
      next[ptyId] = {
        ...entry,
        paneKey: toPaneKey,
        ...(toTabId ? { tabId: toTabId } : {}),
        ...(toLeafId ? { leafId: toLeafId } : {})
      }
    }
  }
  return next ?? entries
}
