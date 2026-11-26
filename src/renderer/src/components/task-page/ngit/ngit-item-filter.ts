import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'

export type NgitView = 'issues' | 'prs'
export type NgitStateFilter = 'open' | 'merged' | 'closed' | 'all'

export function filterNgitItems(
  items: readonly NgitWorkItem[],
  view: NgitView,
  state: NgitStateFilter
): NgitWorkItem[] {
  const type = view === 'issues' ? 'issue' : 'pr'
  return items.filter(
    (item) =>
      item.type === type &&
      // A draft is still open work.
      (state === 'all' || item.state === state || (state === 'open' && item.state === 'draft'))
  )
}
