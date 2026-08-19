import React, { useId } from 'react'
import { LoaderCircle, Pencil } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { ReviewerPickerRow } from './picker-row'

export function ReviewerPicker({
  open,
  submitting,
  canRequestReview,
  reviewerInput,
  reviewerInputRef,
  reviewerMetadataLoading,
  reviewerMetadataError,
  hasReviewerMetadata,
  filteredReviewerCandidates,
  suggestedReviewerRows,
  everyoneElseReviewerRows,
  actionableReviewerRows,
  activeReviewerIndex,
  selectedReviewerLogins,
  onOpenChange,
  onInputChange,
  onActiveIndexChange,
  onEnter,
  onRequestReviewer
}: {
  open: boolean
  submitting: boolean
  canRequestReview: boolean
  reviewerInput: string
  reviewerInputRef: React.RefObject<HTMLInputElement | null>
  reviewerMetadataLoading: boolean
  reviewerMetadataError?: string | null
  hasReviewerMetadata: boolean
  filteredReviewerCandidates: GitHubAssignableUser[]
  suggestedReviewerRows: GitHubAssignableUser[]
  everyoneElseReviewerRows: GitHubAssignableUser[]
  actionableReviewerRows: GitHubAssignableUser[]
  activeReviewerIndex: number
  selectedReviewerLogins: Set<string>
  onOpenChange: (nextOpen: boolean) => void
  onInputChange: (value: string) => void
  onActiveIndexChange: (nextIndex: number | ((current: number) => number)) => void
  onEnter: () => void
  onRequestReviewer: (reviewer: GitHubAssignableUser) => void
}): React.JSX.Element {
  const reviewerListId = useId()
  const reviewerRowId = (index: number): string => `${reviewerListId}-${index}`
  const activeReviewerRow = actionableReviewerRows[activeReviewerIndex] ?? null
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={submitting || !canRequestReview}
          aria-label={translate('auto.components.PullRequestPage.a04c137bb7', 'Reviewer')}
          className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {submitting ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <Pencil className="size-3" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="flex max-h-[420px] w-[330px] flex-col overflow-hidden rounded-md border-border/70 p-0"
        align="end"
        side="bottom"
        sideOffset={6}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <div className="border-b border-border/70 p-2">
          <Input
            ref={reviewerInputRef}
            value={reviewerInput}
            onChange={(event) => onInputChange(event.target.value)}
            disabled={submitting || !canRequestReview}
            placeholder={translate(
              'auto.components.PullRequestPage.3bde131f49',
              'Type or choose a user'
            )}
            aria-label={translate('auto.components.PullRequestPage.a04c137bb7', 'Reviewer')}
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={reviewerListId}
            aria-activedescendant={
              activeReviewerRow ? reviewerRowId(activeReviewerIndex) : undefined
            }
            className="h-8 min-w-0 cursor-text rounded-md border-border/50 bg-background text-xs"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && actionableReviewerRows.length > 0) {
                event.preventDefault()
                onActiveIndexChange((current) => (current + 1) % actionableReviewerRows.length)
                return
              }
              if (event.key === 'ArrowUp' && actionableReviewerRows.length > 0) {
                event.preventDefault()
                onActiveIndexChange(
                  (current) =>
                    (current - 1 + actionableReviewerRows.length) % actionableReviewerRows.length
                )
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                onEnter()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onOpenChange(false)
              }
            }}
          />
        </div>
        <div id={reviewerListId} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          {reviewerMetadataLoading ? (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">
              {translate('auto.components.PullRequestPage.57750f4a8c', 'Loading...')}
            </div>
          ) : filteredReviewerCandidates.length > 0 ? (
            <>
              {suggestedReviewerRows.length > 0 ? (
                <>
                  <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
                    {translate('auto.components.PullRequestPage.828f045847', 'Suggestions')}
                  </div>
                  {suggestedReviewerRows.map((reviewer, index) => (
                    <ReviewerPickerRow
                      key={`suggested:${reviewer.login}`}
                      id={reviewerRowId(index)}
                      reviewer={reviewer}
                      suggested
                      active={actionableReviewerRows[activeReviewerIndex]?.login === reviewer.login}
                      selected={selectedReviewerLogins.has(reviewer.login.toLowerCase())}
                      activeIndex={index}
                      disabled={submitting || !canRequestReview}
                      onHover={onActiveIndexChange}
                      onRequest={onRequestReviewer}
                    />
                  ))}
                </>
              ) : null}
              <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
                {translate('auto.components.PullRequestPage.2760fa29a4', 'Everyone else')}
              </div>
              {everyoneElseReviewerRows.length > 0 ? (
                everyoneElseReviewerRows.map((reviewer, index) => (
                  <ReviewerPickerRow
                    key={`reviewer:${reviewer.login}`}
                    id={reviewerRowId(suggestedReviewerRows.length + index)}
                    reviewer={reviewer}
                    suggested={false}
                    active={actionableReviewerRows[activeReviewerIndex]?.login === reviewer.login}
                    selected={selectedReviewerLogins.has(reviewer.login.toLowerCase())}
                    activeIndex={suggestedReviewerRows.length + index}
                    disabled={submitting || !canRequestReview}
                    onHover={onActiveIndexChange}
                    onRequest={onRequestReviewer}
                  />
                ))
              ) : (
                <div className="px-3 py-2 text-[13px] text-muted-foreground">
                  {translate(
                    'auto.components.PullRequestPage.5ad00c7a0e',
                    'No matching reviewers.'
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">
              {reviewerMetadataError ??
                (hasReviewerMetadata
                  ? translate(
                      'auto.components.PullRequestPage.5ad00c7a0e',
                      'No matching reviewers.'
                    )
                  : translate(
                      'auto.components.PullRequestPage.56ec6eafb7',
                      'Open the PR details to view current reviewers.'
                    ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
