import type { RenderRow } from './render-row'

export const ARCHIVED_MACHINES_ROW_KEY = 'archived-machines'

/**
 * Moves the host sections of archived machines to the end of the list under one "Archived
 * machines (n)" row, collapsed unless `expanded`. Only host-grouped lists have sections to move.
 */
export function groupArchivedMachineHosts(
  rows: readonly RenderRow[],
  archivedHostIds: ReadonlySet<string>,
  expanded: boolean
): RenderRow[] {
  if (archivedHostIds.size === 0) {
    return [...rows]
  }
  const kept: RenderRow[] = []
  const archived: RenderRow[] = []
  let count = 0
  let inArchived = false
  for (const row of rows) {
    if (row.type === 'host-header') {
      inArchived = archivedHostIds.has(row.hostId)
      count += inArchived ? 1 : 0
    }
    ;(inArchived ? archived : kept).push(row)
  }
  if (count === 0) {
    return kept
  }
  const header: RenderRow = {
    type: 'archived-machines',
    key: ARCHIVED_MACHINES_ROW_KEY,
    count,
    expanded
  }
  return expanded ? [...kept, header, ...archived] : [...kept, header]
}
