import React, { useMemo } from 'react'
import type { GitBranchLineTotal } from '../../../../shared/git-status-types'
import { getIntlLocale, translate } from '@/i18n/i18n'

// Why: raw digits, not the grouped display string — screen readers announce
// "8,259" as two numbers in several locales.
function buildAccessibleLabel(added: number, removed: number): string {
  if (added > 0 && removed > 0) {
    return translate(
      'auto.components.right.sidebar.source.control.branch.line.total.chip.daa8e8e59b',
      '{{value0}} additions, {{value1}} deletions',
      { value0: added, value1: removed }
    )
  }
  if (added > 0) {
    return translate(
      'auto.components.right.sidebar.source.control.branch.line.total.chip.8a9b97b666',
      '{{value0}} additions',
      { value0: added }
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.branch.line.total.chip.52c366d88d',
    '{{value0}} deletions',
    { value0: removed }
  )
}

// Absent, incomplete and genuinely-empty all render as nothing: no `+0 -0`, no
// spinner, no reserved width. Not clickable — `openBranchAllDiffs` is narrower.
export const SourceControlBranchLineTotalChip = React.memo(
  function SourceControlBranchLineTotalChip({
    branchLineTotal
  }: {
    branchLineTotal: GitBranchLineTotal | null | undefined
  }): React.JSX.Element | null {
    const added = branchLineTotal?.added ?? 0
    const removed = branchLineTotal?.removed ?? 0
    const hasAdded = added > 0
    const hasRemoved = removed > 0
    // Full precision and app-locale-aware; a status tick that leaves the counts
    // alone must not rebuild these strings.
    const locale = getIntlLocale()
    const addedText = useMemo(() => added.toLocaleString(locale), [added, locale])
    const removedText = useMemo(() => removed.toLocaleString(locale), [removed, locale])
    const accessibleLabel = useMemo(() => buildAccessibleLabel(added, removed), [added, removed])

    if (!hasAdded && !hasRemoved) {
      return null
    }

    // Why: no fixed `ch` width — that clips at 5+ digits; `tabular-nums` alone
    // keeps digits from jittering between refreshes.
    return (
      <span
        role="group"
        aria-label={accessibleLabel}
        data-testid="source-control-branch-line-total"
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums"
      >
        {hasAdded ? (
          <span aria-hidden="true" className="text-[color:var(--git-decoration-added)]">
            +{addedText}
          </span>
        ) : null}
        {hasRemoved ? (
          <span aria-hidden="true" className="text-[color:var(--git-decoration-deleted)]">
            -{removedText}
          </span>
        ) : null}
      </span>
    )
  }
)
