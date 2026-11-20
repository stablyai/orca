import { useState } from 'react'
import type { GiteaAssignableUser } from '../../../../shared/gitea-types'
import { EMPTY_GITEA_ITEM_FILTERS, type GiteaItemFilters } from './gitea/gitea-task-filters'

export function useTaskPageGiteaFilterState() {
  const [giteaItemFilters, setGiteaItemFilters] =
    useState<GiteaItemFilters>(EMPTY_GITEA_ITEM_FILTERS)
  // Why: the server filters issues by assignee, so it lives apart from the client-side filters.
  const [giteaAssigneeFilter, setGiteaAssigneeFilter] = useState('')
  const [giteaLabels, setGiteaLabels] = useState<string[]>([])
  const [giteaAssignableUsers, setGiteaAssignableUsers] = useState<GiteaAssignableUser[]>([])
  return {
    giteaItemFilters,
    setGiteaItemFilters,
    giteaAssigneeFilter,
    setGiteaAssigneeFilter,
    giteaLabels,
    setGiteaLabels,
    giteaAssignableUsers,
    setGiteaAssignableUsers
  }
}
