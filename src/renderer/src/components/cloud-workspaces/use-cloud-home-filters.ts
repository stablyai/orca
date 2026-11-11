import { useCallback, useState } from 'react'
import {
  ANY,
  INITIAL_CLOUD_WORKSPACE_FILTERS,
  type CloudWorkspacesFilters
} from './CloudWorkspacesToolbar'
import { readShowRoutineRuns, writeShowRoutineRuns } from './cloud-workspaces-home-prefs'
import { usePendingHomeFilters } from './cloud-workspaces-home-nav'

/** Home's list filters for this account. The Routine runs switch is remembered; the rest start fresh. */
export function useCloudHomeFilters(account: string) {
  const initialFilters = (key: string): CloudWorkspacesFilters => ({
    ...INITIAL_CLOUD_WORKSPACE_FILTERS,
    routines: readShowRoutineRuns(key)
  })
  const [filters, setFilters] = useState(() => initialFilters(account))
  usePendingHomeFilters(setFilters)
  // Owner and repo filters name the previous team's people and repos; a team switch starts over.
  const [filtersAccount, setFiltersAccount] = useState(account)
  if (filtersAccount !== account) {
    setFiltersAccount(account)
    setFilters(initialFilters(account))
  }
  const changeFilters = useCallback(
    (next: Partial<CloudWorkspacesFilters>) => {
      if (next.routines !== undefined) {
        writeShowRoutineRuns(account, next.routines)
      }
      setFilters((previous) => {
        // A different list (scope or archived) has different owners and repos; start unfiltered.
        // Routine runs only add rows, so the owner/repo picks stay.
        const reset =
          (next.scope !== undefined && next.scope !== previous.scope) ||
          (next.archived !== undefined && next.archived !== previous.archived)
        return { ...previous, ...(reset ? { by: ANY, repo: ANY } : {}), ...next }
      })
    },
    [account]
  )
  return { filters, changeFilters }
}
