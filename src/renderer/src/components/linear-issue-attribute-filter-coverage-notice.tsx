// Why: the transport id cap trims a deduplicated facet row silently, and any surviving id
// keeps that row checked — so the picker has to say how many per-team ids it really applies.
import React from 'react'
import { translate } from '@/i18n/i18n'
import {
  expandLinearMetadataGroupKeys,
  selectedLinearMetadataGroupKeys
} from './linear-issue-attribute-filter-team-ids'

export function LinearFacetCoverageNotice({
  facet,
  options,
  selectedIds
}: {
  facet: 'status' | 'labels'
  options: readonly { key: string; ids: readonly string[] }[]
  selectedIds: readonly string[]
}): React.JSX.Element | null {
  const groupIdCount = expandLinearMetadataGroupKeys(
    options,
    selectedLinearMetadataGroupKeys(options, selectedIds)
  ).length
  if (groupIdCount <= selectedIds.length) {
    return null
  }
  const counts = { value0: selectedIds.length, value1: groupIdCount }
  return (
    <p className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
      {facet === 'status'
        ? translate(
            'auto.components.linear-issue-attribute-filter-coverage-notice.statusPartialTeamCoverage',
            'Filtering {{value0}} of {{value1}} team statuses — issues from the remaining teams are not included.',
            counts
          )
        : translate(
            'auto.components.linear-issue-attribute-filter-coverage-notice.labelsPartialTeamCoverage',
            'Filtering {{value0}} of {{value1}} team labels — issues from the remaining teams are not included.',
            counts
          )}
    </p>
  )
}
