import { GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
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

export function ReviewIcon({
  review,
  className
}: {
  review: WorktreeCardPrDisplay
  className?: string
}): React.JSX.Element {
  const Icon = review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const checkTone =
    review.state !== 'merged' && review.status === 'failure'
      ? 'text-rose-500/85'
      : review.state !== 'merged' && review.status === 'pending'
        ? 'text-amber-500/85'
        : review.state === 'open' && review.status === 'success'
          ? 'text-emerald-500/80'
          : null
  return (
    <Icon
      className={cn(
        className,
        checkTone,
        review.state === 'merged' && 'text-purple-600/70 dark:text-purple-400/70',
        !checkTone && review.state === 'open' && 'text-emerald-500/80',
        !checkTone && review.state === 'closed' && 'text-muted-foreground/60',
        !checkTone && review.state === 'draft' && 'text-muted-foreground/50',
        !checkTone &&
          (!review.state || !['merged', 'open', 'closed', 'draft'].includes(review.state)) &&
          'text-muted-foreground opacity-70'
      )}
    />
  )
}
