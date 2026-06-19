import React from 'react'
import { GitMerge } from 'lucide-react'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { cn } from '@/lib/utils'
import { PullRequestIcon } from './checks-panel-content'

function hostedReviewStateClass(review: HostedReviewInfo): string {
  if (review.state === 'merged') {
    return 'text-purple-500/80'
  }
  if (review.state === 'open') {
    return 'text-emerald-500/80'
  }
  if (review.state === 'closed') {
    return 'text-muted-foreground/60'
  }
  return 'text-muted-foreground/50'
}

export function HostedReviewIcon({
  review,
  className
}: {
  review: HostedReviewInfo
  className?: string
}): React.JSX.Element {
  const Icon = review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  return <Icon className={cn(className, hostedReviewStateClass(review))} />
}

function hostedReviewLabel(review: HostedReviewInfo): string {
  return `${review.provider === 'gitlab' ? 'MR' : 'PR'} #${review.number}`
}

export function HostedReviewHeaderLink({
  review,
  onOpenHostedReviewInChecks
}: {
  review: HostedReviewInfo
  onOpenHostedReviewInChecks: () => void
}): React.JSX.Element {
  const label = hostedReviewLabel(review)
  const className =
    'shrink-0 border-0 bg-transparent p-0 text-left font-medium leading-none text-foreground underline decoration-border underline-offset-2 opacity-80 hover:text-foreground hover:decoration-foreground'

  if (review.provider === 'github' || review.provider === 'gitlab') {
    return (
      <button
        type="button"
        className={className}
        onClick={(e) => {
          e.stopPropagation()
          // Why: GitHub PR and GitLab MR details live in Orca's Checks tab; keep
          // the sidebar workflow in-app instead of opening the browser.
          onOpenHostedReviewInChecks()
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <a
      href={review.url}
      target="_blank"
      rel="noreferrer"
      className={className}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  )
}
