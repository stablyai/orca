/**
 * Map a persisted file-keyed override record onto the ids of files that actually
 * restored, following rename migrations. `keepValue` returns undefined to drop an
 * entry, so each caller decides which persisted values are still meaningful.
 */
export function hydrateFileKeyedOverrides<T>(
  persisted: Record<string, unknown>,
  openFileIds: Set<string>,
  migrationsByWorktree: Record<string, Map<string, string>>,
  keepValue: (value: unknown) => T | undefined
): Record<string, T> {
  const entries = new Map<string, T>()
  for (const [persistedFileId, rawValue] of Object.entries(persisted)) {
    const value = keepValue(rawValue)
    if (value === undefined) {
      continue
    }
    if (openFileIds.has(persistedFileId)) {
      entries.set(persistedFileId, value)
    }
    for (const migrations of Object.values(migrationsByWorktree)) {
      const migratedFileId = migrations.get(persistedFileId)
      if (migratedFileId && openFileIds.has(migratedFileId)) {
        entries.set(migratedFileId, value)
      }
    }
  }
  return Object.fromEntries(entries)
}
