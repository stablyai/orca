import React from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PRReviewerRow } from '@/components/github/pr-reviewer-row'
import { useTranslate } from '@/i18n/use-translate'
import type { getGitHubPRReviewerRows } from '../../../../../shared/github/pull-requests/pr-reviewer-display'

export function ReviewerRequestedList({
  reviewers,
  loading,
  hasReviewerMetadata,
  selectedReviewerLogins,
  submitting,
  canRequestReview,
  onRemove
}: {
  reviewers: ReturnType<typeof getGitHubPRReviewerRows>
  loading: boolean
  hasReviewerMetadata: boolean
  selectedReviewerLogins: Set<string>
  submitting: boolean
  canRequestReview: boolean
  onRemove: (login: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (loading && !hasReviewerMetadata) {
    return (
      <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        {t('auto.components.PullRequestPage.acbd110867', 'Loading reviewers')}
      </div>
    )
  }
  if (reviewers.length === 0) {
    return (
      <div className="py-1 text-[12px] text-muted-foreground">
        {t('auto.components.PullRequestPage.d10b6d5209', 'No reviewers requested.')}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {reviewers.map((reviewer) => {
        const canRemoveReviewer = selectedReviewerLogins.has(reviewer.login.toLowerCase())
        return (
          <PRReviewerRow key={reviewer.login} reviewer={reviewer}>
            {canRemoveReviewer ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                    disabled={submitting || !canRequestReview}
                    aria-label={t(
                      'auto.components.PullRequestPage.ae9a38fd4a',
                      'Remove reviewer {{value0}}',
                      { value0: reviewer.login }
                    )}
                    onClick={() => {
                      onRemove(reviewer.login)
                    }}
                  >
                    <X className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('auto.components.PullRequestPage.7f964a365a', 'Remove reviewer')}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </PRReviewerRow>
        )
      })}
    </div>
  )
}
