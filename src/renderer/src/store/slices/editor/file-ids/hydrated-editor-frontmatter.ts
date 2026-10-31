export function resolveHydratedEditorFrontmatter(
  persistedVisibility: Record<string, boolean>,
  openFileIds: ReadonlySet<string>,
  migrationsByWorktree: Record<string, Map<string, string>>
): Record<string, boolean> {
  const hiddenIds = new Set(
    Object.entries(persistedVisibility)
      .filter(([, visible]) => !visible)
      .map(([id]) => id)
  )
  if (hiddenIds.size === 0) {
    return {}
  }
  const migratedIds = new Map<string, string[]>()
  const addMigration = (from: string, to: string | undefined): void => {
    if (!to || !openFileIds.has(to)) {
      return
    }
    const targets = migratedIds.get(from)
    if (targets) {
      targets.push(to)
    } else {
      migratedIds.set(from, [to])
    }
  }
  for (const migrations of Object.values(migrationsByWorktree)) {
    // Scan the smaller side so sparse overrides never pay for a large migration map.
    if (migrations.size < hiddenIds.size) {
      for (const [from, to] of migrations) {
        if (hiddenIds.has(from)) {
          addMigration(from, to)
        }
      }
    } else {
      for (const from of hiddenIds) {
        addMigration(from, migrations.get(from))
      }
    }
  }
  const hidden = new Map<string, boolean>()
  for (const persistedId of hiddenIds) {
    if (openFileIds.has(persistedId)) {
      hidden.set(persistedId, false)
    }
    for (const migratedId of migratedIds.get(persistedId) ?? []) {
      hidden.set(migratedId, false)
    }
  }
  return Object.fromEntries(hidden)
}
