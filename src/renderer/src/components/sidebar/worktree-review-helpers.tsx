import { createElement } from 'react'
import { GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  reviewStatusPresentation,
  type ReviewStatusTone
} from '../../../../shared/review-status-presentation'
import { getReviewStateIcon } from '@/components/github/review-state-presentation'
import { PullRequestIcon } from './WorktreeCardHelpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export function getReviewLabel(review: WorktreeCardPrDisplay): 'MR' | 'PR' {
  return review.provider === 'gitlab' ? 'MR' : 'PR'
}

export function getProviderName(review: WorktreeCardPrDisplay): string {
  if (review.provider === 'gitlab') {
    return 'GitLab'
  }
  if (review.provider === 'bitbucket') {
    return 'Bitbucket'
  }
  if (review.provider === 'azure-devops') {
    return 'Azure DevOps'
  }
  if (review.provider === 'gitea') {
    return 'Gitea'
  }
  return 'GitHub'
}

// Open reviews take check tones; draft/closed/merged keep state tones, and unconfirmed stateless rows flag problems only.
export function getReviewChecksTone(status: WorktreeCardPrDisplay['status']): string | null {
  if (status === 'failure') {
    return 'text-rose-500/85'
  }
  if (status === 'pending') {
    return 'text-amber-500/85'
  }
  if (status === 'success') {
    return 'text-emerald-500/80'
  }
  return null
}

const REVIEW_TONE_CLASSES: Record<ReviewStatusTone, string> = {
  failure: 'text-rose-500/85',
  pending: 'text-amber-500/85',
  success: 'text-emerald-500/80',
  open: 'text-emerald-500/80',
  merged: 'text-purple-600/70 dark:text-purple-400/70',
  closed: 'text-muted-foreground/60',
  draft: 'text-muted-foreground/50',
  neutral: 'text-muted-foreground opacity-70'
}

export function ReviewIcon({
  review,
  className,
  variant = 'provider',
  showChecks = true
}: {
  review: WorktreeCardPrDisplay
  className?: string
  variant?: 'provider' | 'generic'
  showChecks?: boolean
}): React.JSX.Element {
  const providerIcon =
    variant === 'provider' && review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const Icon = getReviewStateIcon(review.state) ?? providerIcon
  const presentation = reviewStatusPresentation({
    state: review.state,
    checksStatus: review.status,
    showChecks
  })
  return createElement(Icon, { className: cn(className, REVIEW_TONE_CLASSES[presentation.tone]) })
}
