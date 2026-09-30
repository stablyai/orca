import { createElement } from 'react'
import { GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getReviewStateIcon } from '@/components/github/review-state-presentation'
import { PullRequestIcon } from './WorktreeCardHelpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { PRReviewDecision } from '../../../../shared/github/pull-request-types'

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

// Why: checks only gate a review that is actually open; draft/closed/merged keep
// their state tone so the glyph agrees with its tooltip. A stateless row (folder
// cards render one while a linked review is loading or its details failed) has no
// state glyph to contradict, so it still flags problems — but never claims success,
// since emerald would assert an open review we have not confirmed.
function getCheckTone(review: WorktreeCardPrDisplay): string | null {
  if (review.state && review.state !== 'open') {
    return null
  }
  if (review.status === 'failure') {
    return 'text-rose-500/85'
  }
  if (review.status === 'pending') {
    return 'text-amber-500/85'
  }
  if (review.state === 'open' && review.status === 'success') {
    return 'text-emerald-500/80'
  }
  return null
}

function getStateTone(state: WorktreeCardPrDisplay['state']): string {
  if (state === 'merged') {
    return 'text-purple-600/70 dark:text-purple-400/70'
  }
  if (state === 'open') {
    return 'text-emerald-500/80'
  }
  if (state === 'closed') {
    return 'text-muted-foreground/60'
  }
  if (state === 'draft') {
    return 'text-muted-foreground/50'
  }
  return 'text-muted-foreground opacity-70'
}

// Why: a finished review's decision is stale noise; only open/draft reviews surface it.
export function getActiveReviewDecision(review: WorktreeCardPrDisplay): PRReviewDecision | null {
  if (!('reviewDecision' in review) || review.state === 'merged' || review.state === 'closed') {
    return null
  }
  return review.reviewDecision ?? null
}

/** Label for the verdicts the decision dot shows; screen readers can't see the dot. */
export function getReviewDecisionDotLabel(review: WorktreeCardPrDisplay): string | null {
  const decision = getActiveReviewDecision(review)
  if (decision === 'APPROVED') {
    return translate('auto.components.sidebar.WorktreeReviewDecision.approved', 'Approved')
  }
  if (decision === 'CHANGES_REQUESTED') {
    return translate(
      'auto.components.sidebar.WorktreeReviewDecision.changesRequested',
      'Changes requested'
    )
  }
  return null
}

// Why: review-required is the default for most open PRs, so only a verdict earns a dot.
function getDecisionDotTone(decision: PRReviewDecision | null): string | null {
  if (decision === 'APPROVED') {
    return 'bg-emerald-500'
  }
  if (decision === 'CHANGES_REQUESTED') {
    return 'bg-amber-500'
  }
  return null
}

export function ReviewIcon({
  review,
  className,
  variant = 'provider',
  showDecisionDot = true
}: {
  review: WorktreeCardPrDisplay
  className?: string
  variant?: 'provider' | 'generic'
  showDecisionDot?: boolean
}): React.JSX.Element {
  const providerIcon =
    variant === 'provider' && review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const Icon = getReviewStateIcon(review.state) ?? providerIcon
  const icon = createElement(Icon, {
    className: cn(className, getCheckTone(review) ?? getStateTone(review.state))
  })
  const dotTone = showDecisionDot ? getDecisionDotTone(getActiveReviewDecision(review)) : null
  if (!dotTone) {
    return icon
  }
  // Why: a separate dot keeps the review verdict distinct from the icon's CI tone.
  return (
    <span className="relative inline-flex shrink-0">
      {icon}
      <span
        data-review-decision-dot=""
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute -bottom-px -right-px size-[5px] rounded-full ring-1 ring-sidebar',
          dotTone
        )}
      />
    </span>
  )
}
