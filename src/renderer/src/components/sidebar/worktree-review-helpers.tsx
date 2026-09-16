import { createElement } from 'react'
import { GitMerge, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
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

export function ReviewIcon({
  review,
  className,
  variant = 'provider'
}: {
  review: WorktreeCardPrDisplay
  className?: string
  variant?: 'provider' | 'generic'
}): React.JSX.Element {
  const providerIcon =
    variant === 'provider' && review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const Icon = getReviewStateIcon(review.state) ?? providerIcon
  return createElement(Icon, {
    className: cn(className, getCheckTone(review) ?? getStateTone(review.state))
  })
}

export function getUnresolvedReviewCommentCount(review: WorktreeCardPrDisplay | null): number {
  return review && 'unresolvedReviewCommentCount' in review
    ? (review.unresolvedReviewCommentCount ?? 0)
    : 0
}

/** Speech-bubble count beside the review glyph; callers hide it at zero. */
export function ReviewCommentCountBadge({ count }: { count: number }): React.JSX.Element {
  const label =
    count === 1
      ? translate(
          'auto.components.sidebar.WorktreeCardMeta.unresolvedCommentOne',
          '1 unresolved comment'
        )
      : translate(
          'auto.components.sidebar.WorktreeCardMeta.unresolvedCommentOther',
          '{{count}} unresolved comments',
          { count }
        )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex h-3.5 shrink-0 items-center gap-0.5 text-[10px] font-medium tabular-nums leading-none text-muted-foreground/70 hover:text-foreground"
          data-testid="review-comment-count"
        >
          <MessageSquare className="size-3" aria-hidden="true" />
          {count}
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
