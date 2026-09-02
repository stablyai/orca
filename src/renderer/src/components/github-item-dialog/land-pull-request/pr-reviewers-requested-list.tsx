import React from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReviewerAvatar } from '@/components/github/work-item-state-presentation'
import type { GitHubPRReviewerRow } from '@/components/github-pr-reviewer-display'
import { translate } from '@/i18n/i18n'

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
  if (loading && !hasReviewerMetadata) {
    return (
      <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        {translate('auto.components.GitHubItemDialog.6a45771d47', 'Loading reviewers')}
      </div>
    )
  }
  if (reviewers.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        {reviewers.map((reviewer) => {
          const canRemoveReviewer = selectedReviewerLogins.has(reviewer.login.toLowerCase())
          return (
            <div key={reviewer.login} className="flex min-w-0 items-center gap-2">
              <ReviewerAvatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-foreground">
                  {reviewer.login}
                </div>
                {reviewer.name ? (
                  <div className="truncate text-[11px] text-muted-foreground">{reviewer.name}</div>
                ) : null}
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {reviewer.stateLabel}
              </span>
              {canRemoveReviewer ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                      disabled={submitting || !canRequestReview}
                      aria-label={translate(
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
                    {translate('auto.components.GitHubItemDialog.5c1c973855', 'Remove reviewer')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="py-1 text-[12px] text-muted-foreground">
      {translate('auto.components.GitHubItemDialog.36f9ac4a47', 'No reviewers requested.')}
    </div>
  )
}
