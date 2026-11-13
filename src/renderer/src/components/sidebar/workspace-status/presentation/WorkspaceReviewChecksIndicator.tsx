import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import React from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WorkspaceReviewChecksSummary } from '../../../../../../shared/workspace-review-checks'
import { ReviewIcon } from '../../workspace-card/review/worktree-review-presentation'
import { reviewStateLabel } from '../../workspace-card/metadata/WorktreeCardMetadataStatusBadges'

export function workspaceReviewChecksLabel(
  summary: WorkspaceReviewChecksSummary,
  t: Translate = translate
): string {
  const outcome = getProviderChecksOutcome(summary)
  const status =
    outcome === 'cancelled'
      ? t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
      : outcome === 'failure'
        ? t('workspace.links.checksFailed', 'Failed')
        : outcome === 'pending'
          ? t('workspace.links.checksPending', 'Pending')
          : outcome === 'success'
            ? t('workspace.links.checksPassing', 'Passing')
            : outcome === 'unknown'
              ? t('workspace.links.checksUnknown', 'Unknown')
              : t('workspace.links.checksNeutral', 'Neutral')
  const checks = t('workspace.links.allReviewChecks', 'Reviews: {{count}} · Checks: {{status}}', {
    count: summary.total,
    status
  })
  const state =
    summary.reviewState === 'draft'
      ? t('workspace.reviewStatus.draft', '{{review}}: Draft', {
          review: t('workspace.links.reviews', 'Reviews')
        })
      : reviewStateLabel(summary.reviewState, 'PR', t)
  return `${state} · ${checks}`
}

export function WorkspaceReviewChecksIndicator({
  summary,
  className
}: {
  summary: WorkspaceReviewChecksSummary
  className?: string
}): React.JSX.Element {
  return (
    <ReviewIcon
      review={{ state: summary.reviewState }}
      className={className}
      variant="generic"
      showChecks={false}
    />
  )
}
