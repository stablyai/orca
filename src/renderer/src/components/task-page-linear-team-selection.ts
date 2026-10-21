import type { LinearTeam } from '../../../shared/linear/workspace-types'

// Why: the persisted value is not validated on the way in and a string reached
// 1.4.207 (0a2b6e7f); anything but a string array reads as sticky-all.
export function storedLinearTeamSelection(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.filter((id): id is string => typeof id === 'string')
}

// Why `unknown`: this is the crash site, so it must hold for the raw setting too.
export function reconcileLinearTeamSelection(
  availableTeams: LinearTeam[],
  storedSelection: unknown
): ReadonlySet<string> {
  const availableIds = availableTeams.map((team) => team.id)
  if (availableIds.length === 0) {
    return new Set()
  }

  const availableIdSet = new Set(availableIds)
  const validStoredSelection = (storedLinearTeamSelection(storedSelection) ?? []).filter((id) =>
    availableIdSet.has(id)
  )
  if (validStoredSelection.length > 0) {
    return new Set(validStoredSelection)
  }

  return new Set(availableIds)
}
