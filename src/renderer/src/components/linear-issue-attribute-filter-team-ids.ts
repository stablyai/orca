import type { LinearTeam } from '../../../shared/types'

/**
 * Resolve which Linear team ids should feed attribute-filter metadata.
 * Empty selection falls back to the same primary-team default as before;
 * non-empty selection returns every selected team (sorted for stable loads).
 */
export function resolveLinearIssueAttributeFilterTeamIds(options: {
  selectedTeamIds: readonly string[]
  availableTeams: readonly LinearTeam[]
  primaryTeamId: string | null
}): string[] {
  const { selectedTeamIds, availableTeams, primaryTeamId } = options
  const availableIds = new Set(availableTeams.map((team) => team.id))
  const selected = selectedTeamIds.filter((id) => availableIds.has(id))
  if (selected.length > 0) {
    // Stable order: name/id of available teams, not click order — matches primary-team sort.
    const byId = new Map(availableTeams.map((team) => [team.id, team] as const))
    return [...selected].sort((a, b) => {
      const teamA = byId.get(a)
      const teamB = byId.get(b)
      const nameCmp = (teamA?.name ?? a).localeCompare(teamB?.name ?? b)
      if (nameCmp !== 0) {
        return nameCmp
      }
      return a.localeCompare(b)
    })
  }
  if (primaryTeamId && availableIds.has(primaryTeamId)) {
    return [primaryTeamId]
  }
  return []
}

/** Deduplicate metadata rows by id, preserving first-seen order. */
export function unionLinearMetadataById<T extends { id: string }>(groups: readonly T[][]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) {
        continue
      }
      seen.add(item.id)
      out.push(item)
    }
  }
  return out
}
