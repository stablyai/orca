import type { LinearTeam } from '../../../shared/types'

export function reconcileLinearTeamSelection(
  availableTeams: LinearTeam[],
  storedSelection: readonly string[] | null | undefined
): ReadonlySet<string> {
  const availableIds = availableTeams.map((team) => team.id)
  if (availableIds.length === 0) {
    return new Set()
  }

  const availableIdSet = new Set(availableIds)
  const validStoredSelection = (storedSelection ?? []).filter((id) => availableIdSet.has(id))
  if (validStoredSelection.length > 0) {
    return new Set(validStoredSelection)
  }

  return new Set(availableIds)
}
