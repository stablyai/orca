import React from 'react'
import { translate } from '@/i18n/i18n'
import type { WorkspaceReviewChecksSummary } from '../../../../shared/workspace-review-checks'
import { ReviewIcon } from './worktree-review-helpers'
import { reviewStateLabel } from './WorktreeCardMetadataStatusBadges'

export function workspaceReviewChecksLabel(summary: WorkspaceReviewChecksSummary): string {
  const status =
    summary.state === 'failure'
      ? translate('workspace.links.checksFailed', 'Failed')
      : summary.state === 'pending'
        ? translate('workspace.links.checksPending', 'Pending')
        : summary.state === 'success'
          ? translate('workspace.links.checksPassing', 'Passing')
          : summary.state === 'unknown'
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
