import { getProviderChecksOutcome } from '../../../../shared/source-control/checks/provider-check-summary'
import React from 'react'
import { translate } from '@/i18n/i18n'
import type { WorkspaceReviewChecksSummary } from '../../../../shared/workspace-review-checks'
import { ReviewIcon } from './workspace-card/review/worktree-review-presentation'
import { reviewStateLabel } from './workspace-card/metadata/WorktreeCardMetadataStatusBadges'

export function workspaceReviewChecksLabel(summary: WorkspaceReviewChecksSummary): string {
  const outcome = getProviderChecksOutcome(summary)
  const status =
    outcome === 'cancelled'
      ? translate('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
      : outcome === 'failure'
        ? translate('workspace.links.checksFailed', 'Failed')
        : outcome === 'pending'
          ? translate('workspace.links.checksPending', 'Pending')
          : outcome === 'success'
            ? translate('workspace.links.checksPassing', 'Passing')
            : outcome === 'unknown'
              ? translate('workspace.links.checksUnknown', 'Unknown')
              : translate('workspace.links.checksNeutral', 'Neutral')
  const checks = translate(
    'workspace.links.allReviewChecks',
    'Reviews: {{count}} · Checks: {{status}}',
    {
      count: summary.total,
      status
    }
  )
  const state =
    summary.reviewState === 'draft'
      ? translate('workspace.reviewStatus.draft', '{{review}}: Draft', {
          review: translate('workspace.links.reviews', 'Reviews')
        })
      : reviewStateLabel(summary.reviewState, 'PR')
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
