// Why: the pills are the only place an applied Linear facet filter is visible once the
// popover closes, so they carry the same coverage truth the picker shows inline.
import { translate } from '@/i18n/i18n'
import {
  canonicalizeLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../shared/linear/issue-attribute-filter'
import { getLinearPriorityLabel } from './task-page-localized-options'
import { isLinearMetadataGroupSelectionPartial } from './linear-issue-attribute-filter-team-ids'
import type {
  LinearIssueFilterGroupedOption,
  LinearIssueFilterSectionKey
} from './linear-issue-attribute-filter-sections'

/** Same-named ids from different teams are one selection to the user. */
function distinctFacetNames(ids: readonly string[], namesById: Map<string, string>): string[] {
  return [...new Set(ids.map((id) => namesById.get(id) ?? id))]
}

export function countLinearIssueAttributeFilters(value: LinearIssueAttributeFilter): number {
  const canonical = canonicalizeLinearIssueAttributeFilter(value)
  return (
    (canonical.stateIds.length > 0 ? 1 : 0) +
    (canonical.priorities.length > 0 ? 1 : 0) +
    (canonical.assignee ? 1 : 0) +
    (canonical.labelIds.length > 0 ? 1 : 0)
  )
}

export function clearLinearIssueAttributeFacet(
  value: LinearIssueAttributeFilter,
  facet: LinearIssueFilterSectionKey
): LinearIssueAttributeFilter {
  switch (facet) {
    case 'status':
      return { ...value, stateIds: [] }
    case 'priority':
      return { ...value, priorities: [] }
    case 'assignee':
      return { ...value, assignee: null }
    case 'labels':
      return { ...value, labelIds: [] }
  }
}

/** A removable filter pill; `partial` marks a facet the transport id cap trimmed (#16879). */
export type LinearIssueFilterPill = {
  key: LinearIssueFilterSectionKey
  label: string
  value: string
  partial: boolean
}

export function linearIssueAttributeFilterPillLabels(options: {
  value: LinearIssueAttributeFilter
  stateNamesById: Map<string, string>
  memberNamesById: Map<string, string>
  labelNamesById: Map<string, string>
  statusOptions: readonly LinearIssueFilterGroupedOption[]
  labelOptions: readonly LinearIssueFilterGroupedOption[]
  /** Recorded where the cap ran, not inferred from the ids it left behind (STA-5996). */
  statusTruncated: boolean
  labelsTruncated: boolean
}): LinearIssueFilterPill[] {
  const canonical = canonicalizeLinearIssueAttributeFilter(options.value)
  const pills: LinearIssueFilterPill[] = []
  if (canonical.stateIds.length > 0) {
    pills.push({
      key: 'status',
      label: translate('auto.components.linear-issue-attribute-filter-sections.status', 'Status'),
      value: distinctFacetNames(canonical.stateIds, options.stateNamesById).join(', '),
      partial: isLinearMetadataGroupSelectionPartial(
        options.statusOptions,
        canonical.stateIds,
        options.statusTruncated
      )
    })
  }
  if (canonical.priorities.length > 0) {
    pills.push({
      key: 'priority',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.priority',
        'Priority'
      ),
      value: canonical.priorities.map((p) => getLinearPriorityLabel(p)).join(', '),
      partial: false
    })
  }
  if (canonical.assignee?.kind === 'unassigned') {
    pills.push({
      key: 'assignee',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.assignee',
        'Assignee'
      ),
      value: translate(
        'auto.components.linear-issue-attribute-filter-sections.unassigned',
        'Unassigned'
      ),
      partial: false
    })
  } else if (canonical.assignee?.kind === 'user') {
    pills.push({
      key: 'assignee',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.assignee',
        'Assignee'
      ),
      value: options.memberNamesById.get(canonical.assignee.id) ?? canonical.assignee.id,
      partial: false
    })
  }
  if (canonical.labelIds.length > 0) {
    pills.push({
      key: 'labels',
      label: translate('auto.components.linear-issue-attribute-filter-sections.labels', 'Labels'),
      value: distinctFacetNames(canonical.labelIds, options.labelNamesById).join(', '),
      partial: isLinearMetadataGroupSelectionPartial(
        options.labelOptions,
        canonical.labelIds,
        options.labelsTruncated
      )
    })
  }
  return pills
}
