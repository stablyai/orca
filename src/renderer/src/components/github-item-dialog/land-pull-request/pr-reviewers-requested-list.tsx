import React from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PRReviewerRow } from '@/components/github/pr-reviewer-row'
import type { GitHubPRReviewerRow } from '../../../../../shared/github/pull-requests/pr-reviewer-display'
import { useTranslate } from '@/i18n/use-translate'

export function PRReviewersRequestedList({
  loading,
  hasReviewerMetadata,
  reviewers,
  selectedReviewerLogins,
  submitting,
  canRequestReview,
  onRemoveReviewers
}: {
  loading: boolean
  hasReviewerMetadata: boolean
  reviewers: GitHubPRReviewerRow[]
  selectedReviewerLogins: Set<string>
  submitting: boolean
  canRequestReview: boolean
  onRemoveReviewers: (reviewersToRemove: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (loading && !hasReviewerMetadata) {
    return (
      <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        {t('auto.components.GitHubItemDialog.6a45771d47', 'Loading reviewers')}
      </div>
    )
  }
  if (reviewers.length > 0) {
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
                        'auto.components.GitHubItemDialog.8b15a5e91c',
                        'Remove reviewer {{value0}}',
                        { value0: reviewer.login }
                      )}
                      onClick={() => {
                        onRemoveReviewers([reviewer.login])
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('auto.components.GitHubItemDialog.5c1c973855', 'Remove reviewer')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </PRReviewerRow>
          )
        })}
      </div>
    )
  }
  return (
    <div className="py-1 text-[12px] text-muted-foreground">
      {t('auto.components.GitHubItemDialog.36f9ac4a47', 'No reviewers requested.')}
    </div>
  )
}
