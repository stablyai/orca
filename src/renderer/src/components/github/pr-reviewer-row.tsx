import React from 'react'
import { Users } from 'lucide-react'
import { ReviewerAvatar } from '@/components/github/work-item-state-presentation'
import type { GitHubPRReviewerRow } from '../../../../shared/github/pull-requests/pr-reviewer-display'

export function PRReviewerRow({
  reviewer,
  children
}: {
  reviewer: GitHubPRReviewerRow
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {reviewer.isTeam ? (
        <span
          aria-hidden
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted text-muted-foreground"
        >
          <Users className="size-3.5" />
        </span>
      ) : (
        <ReviewerAvatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">{reviewer.login}</div>
        {reviewer.name ? (
          <div className="truncate text-2xs text-muted-foreground">{reviewer.name}</div>
        ) : null}
      </div>
      <span className="shrink-0 text-2xs text-muted-foreground">{reviewer.stateLabel}</span>
      {children}
    </div>
  )
}
