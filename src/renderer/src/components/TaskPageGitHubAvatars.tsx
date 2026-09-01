import type { GitHubPRPrimaryReviewer } from '@/components/github-pr-reviewer-display'
import React from 'react'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import { Users } from 'lucide-react'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
export function ReviewChipAvatar({
  reviewer,
  avatarHost
}: {
  reviewer: GitHubPRPrimaryReviewer | null
  avatarHost?: string
}): React.JSX.Element {
  if (reviewer?.login) {
    // Why: review requests may contain only logins; use the PR host before falling back to initials.
    const avatarUrl =
      reviewer.avatarUrl || `https://${avatarHost ?? 'github.com'}/${reviewer.login}.png?size=40`
    return (
      <GitHubUserAvatar
        login={reviewer.login}
        name={reviewer.name}
        avatarUrl={avatarUrl}
        title={reviewer.name ? `${reviewer.name} (${reviewer.login})` : reviewer.login}
        className="size-5"
      />
    )
  }
  return <Users className="size-5 shrink-0" />
}
export function GitHubAssigneeAvatar({
  assignee
}: {
  assignee: GitHubAssignableUser
}): React.JSX.Element {
  if (assignee.avatarUrl) {
    return (
      <img
        src={assignee.avatarUrl}
        alt={assignee.login}
        loading="lazy"
        decoding="async"
        title={assignee.name ? `${assignee.name} (${assignee.login})` : assignee.login}
        className="size-5 rounded-full border border-border/40 bg-muted object-cover"
      />
    )
  }
  return (
    <span
      title={assignee.login}
      className="inline-flex size-5 items-center justify-center rounded-full border border-border/40 bg-muted text-[10px] font-medium text-muted-foreground"
    >
      {assignee.login.slice(0, 1).toUpperCase()}
    </span>
  )
}
