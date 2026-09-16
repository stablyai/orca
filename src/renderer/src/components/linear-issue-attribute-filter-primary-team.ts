import type { LinearTeam } from '../../../shared/linear/workspace-types'

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
  const selectedIds = new Set(selectedTeamIds)
  let firstAvailable: LinearTeam | null = null
  let firstSelected: LinearTeam | null = null
  for (const team of availableTeams) {
    if (!firstAvailable || compareTeamNameId(team, firstAvailable) < 0) {
      firstAvailable = team
    }
    if (
      selectedIds.has(team.id) &&
      (!firstSelected || compareTeamNameId(team, firstSelected) < 0)
    ) {
      firstSelected = team
    }
  }
  return firstSelected ?? firstAvailable
}
