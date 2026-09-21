// Why: the transport id cap trims a deduplicated facet row silently, and any surviving id
// keeps that row checked — so the picker has to say how many per-team ids it really applies.
import React from 'react'
import { translate } from '@/i18n/i18n'
import { linearMetadataGroupCoverage } from './linear-issue-attribute-filter-team-ids'

type LinearCoverageFacet = 'status' | 'labels'

function shortfallMessage(facet: LinearCoverageFacet, applied: number, intended: number): string {
  const counts = { value0: applied, value1: intended }
  return facet === 'status'
    ? translate(
        'auto.components.linear-issue-attribute-filter-coverage-notice.statusPartialTeamCoverage',
        'Filtering {{value0}} of {{value1}} team statuses — issues from the remaining teams are not included.',
        counts
      )
    : translate(
        'auto.components.linear-issue-attribute-filter-coverage-notice.labelsPartialTeamCoverage',
        'Filtering {{value0}} of {{value1}} team labels — issues from the remaining teams are not included.',
        counts
      )
}

/** Why: a row the cap could not fit leaves no trace, so the spent budget is what we can state. */
function idLimitMessage(facet: LinearCoverageFacet, max: number): string {
  return facet === 'status'
    ? translate(
        'auto.components.linear-issue-attribute-filter-coverage-notice.statusAtIdLimit',
        'Filtering the most this can carry: {{value0}} team statuses. Rows picked past that are left out.',
        { value0: max }
      )
    : translate(
        'auto.components.linear-issue-attribute-filter-coverage-notice.labelsAtIdLimit',
        'Filtering the most this can carry: {{value0}} team labels. Rows picked past that are left out.',
        { value0: max }
      )
}

export function LinearFacetCoverageNotice({
  facet,
  options,
  selectedIds,
  max,
  truncated
}: {
  facet: LinearCoverageFacet
  options: readonly { key: string; ids: readonly string[] }[]
  selectedIds: readonly string[]
  max: number
  /** Recorded where the cap ran, not inferred from the ids it left behind (STA-5996). */
  truncated: boolean
}): React.JSX.Element | null {
  const { applied, intended } = linearMetadataGroupCoverage(options, selectedIds)
  if (intended <= applied && !truncated) {
    return null
  }
  return (
    <p className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
      {intended > applied ? shortfallMessage(facet, applied, intended) : idLimitMessage(facet, max)}
    </p>
  )
}
