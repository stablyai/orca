import type { OccurrenceSectionPath } from '../worktree-occurrence-plan'
import type { HostSectionRow } from './host-section-rows'

export type HeaderRevealPlacement = { parent?: OccurrenceSectionPath; hostKey?: string }

/** Read the actual uncollapsed host transform; repeated headers keep their first rendered occurrence. */
export function collectHeaderRevealPlacements(
  rows: readonly HostSectionRow[],
  paths: ReadonlyMap<string, OccurrenceSectionPath>
): ReadonlyMap<string, HeaderRevealPlacement> {
  const placements = new Map<string, HeaderRevealPlacement>()
  let hostKey: string | undefined
  for (const row of rows) {
    if (row.type === 'host-header') {
      hostKey = row.key
    } else if (row.type === 'header' && !placements.has(row.key)) {
      placements.set(row.key, { parent: paths.get(row.key)?.parent, hostKey })
    }
  }
  return placements
}
