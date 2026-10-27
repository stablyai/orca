import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceReviewChecksSummary } from '../../../../shared/workspace-review-checks'
import { PullRequestIcon } from './WorktreeCardHelpers'
import { getReviewChecksTone } from './worktree-review-helpers'

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
  return translate('workspace.links.allReviewChecks', 'Reviews: {{count}} · Checks: {{status}}', {
    count: summary.total,
    status
  })
}

export function WorkspaceReviewChecksIndicator({
  summary,
  className
}: {
  summary: WorkspaceReviewChecksSummary
  className?: string
}): React.JSX.Element {
  const tone =
    summary.state === 'failure' || summary.state === 'pending' || summary.state === 'success'
      ? getReviewChecksTone(summary.state)
      : null
  return <PullRequestIcon className={cn(className, tone ?? 'text-muted-foreground')} />
}
