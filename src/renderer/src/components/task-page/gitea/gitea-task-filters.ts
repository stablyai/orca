import type { GiteaAssignableUser, GiteaWorkItem } from '../../../../../shared/gitea-types'
import type { GiteaTaskView } from '../task-page-localized-options'

export type GiteaStateFilter = 'opened' | 'merged' | 'closed' | 'all'

export type GiteaItemFilters = {
  author: string
  label: string
  search: string
}

export const EMPTY_GITEA_ITEM_FILTERS: GiteaItemFilters = { author: '', label: '', search: '' }

const ISSUE_STATE_FILTERS: readonly GiteaStateFilter[] = ['opened', 'closed', 'all']
const PR_STATE_FILTERS: readonly GiteaStateFilter[] = ['opened', 'merged', 'closed', 'all']

export function giteaStateFiltersFor(view: GiteaTaskView): readonly GiteaStateFilter[] {
  return view === 'issues' ? ISSUE_STATE_FILTERS : view === 'prs' ? PR_STATE_FILTERS : []
}

export function isGiteaStateFilterValidFor(view: GiteaTaskView, filter: GiteaStateFilter): boolean {
  return view === 'notifications' || giteaStateFiltersFor(view).includes(filter)
}

export function giteaAuthorOptions(items: readonly GiteaWorkItem[]): string[] {
  return [...new Set(items.flatMap((item) => (item.author ? [item.author] : [])))].sort()
}

export function giteaLabelOptions(
  items: readonly GiteaWorkItem[],
  repoLabels: readonly string[]
): string[] {
  return [...new Set([...repoLabels, ...items.flatMap((item) => item.labels)])].sort()
}

export function giteaAssigneeOptions(users: readonly GiteaAssignableUser[]): string[] {
  return users.map((user) => user.username).sort()
}

export function filterGiteaWorkItems(
  items: readonly GiteaWorkItem[],
  filters: GiteaItemFilters
): GiteaWorkItem[] {
  const search = filters.search.trim().toLowerCase()
  return items.filter(
    (item) =>
      (!filters.author || item.author === filters.author) &&
      (!filters.label || item.labels.includes(filters.label)) &&
      (!search || item.title.toLowerCase().includes(search) || `#${item.number}`.includes(search))
  )
}
