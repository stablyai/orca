import type { HostSectionRow } from './host-section-rows'

/** Read fully expanded rows so collapsed ancestors and virtualization cannot hide section keys. */
export function collectSectionCollapseKeys(rows: readonly HostSectionRow[]): string[] {
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.type === 'host-header') {
      keys.add(row.key)
    } else if (row.type === 'header' && row.icon.kind !== 'all' && row.count > 0) {
      keys.add(row.collapseKey ?? row.key)
    }
  }
  return [...keys]
}

export function shouldCollapseAllGroups(
  keys: readonly string[],
  collapsedGroups: ReadonlySet<string>
): boolean {
  return keys.some((key) => !collapsedGroups.has(key))
}
