import type { LinearTeam } from '../../../shared/types'

function compareTeamNameId(a: LinearTeam, b: LinearTeam): number {
  const nameCmp = a.name.localeCompare(b.name)
  if (nameCmp !== 0) {
    return nameCmp
  }
  return a.id.localeCompare(b.id)
}

/** Deterministic primary team: first selected by name/id, else first available. */
export function resolveLinearIssueAttributeFilterPrimaryTeam(options: {
  selectedTeamIds: string[]
  availableTeams: LinearTeam[]
}): LinearTeam | null {
  const { selectedTeamIds, availableTeams } = options
  if (availableTeams.length === 0) {
    return null
  }
  if (selectedTeamIds.length === 0) {
    return [...availableTeams].sort(compareTeamNameId)[0] ?? null
  }
  const selected = availableTeams
    .filter((team) => selectedTeamIds.includes(team.id))
    .sort(compareTeamNameId)
  if (selected.length > 0) {
    return selected[0] ?? null
  }
  return [...availableTeams].sort(compareTeamNameId)[0] ?? null
}
