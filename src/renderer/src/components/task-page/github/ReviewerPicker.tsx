import type { Dispatch, RefCallback, SetStateAction } from 'react'
import { Check } from 'lucide-react'

import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { PopoverContent } from '@/components/ui/popover'

import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../../shared/repo-types'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'

type ReviewerPickerProps = {
  actionableReviewerRows: GitHubAssignableUser[]
  activeReviewerIndex: number
  everyoneElseReviewerRows: GitHubAssignableUser[]
  filteredReviewerCandidates: GitHubAssignableUser[]
  handleRequestReview: (requestedLogins?: string[]) => Promise<void>
  handleReviewerPickerOpenChange: (nextOpen: boolean) => void
  hasReviewerMetadata: boolean
  repo: Repo | null
  requestReviewer: (reviewer: GitHubAssignableUser) => Promise<void>
  reviewerInput: string
  reviewerMetadataError: string | null
  reviewerMetadataLoading: boolean
  reviewerPickerMaxHeight: number | null
  reviewerPickerSide: 'top' | 'bottom'
  selectedReviewerLogins: ReadonlySet<string>
  setActiveReviewerIndex: (nextIndex: number | ((current: number) => number)) => void
  setReviewerInput: Dispatch<SetStateAction<string>>
  setReviewerInputNode: RefCallback<HTMLInputElement>
  submitting: boolean
  suggestedReviewerRows: GitHubAssignableUser[]
}

export function TaskPageGitHubReviewerPicker({
  actionableReviewerRows,
  activeReviewerIndex,
  everyoneElseReviewerRows,
  filteredReviewerCandidates,
  handleRequestReview,
  handleReviewerPickerOpenChange,
  hasReviewerMetadata,
  repo,
  requestReviewer,
  reviewerInput,
  reviewerMetadataError,
  reviewerMetadataLoading,
  reviewerPickerMaxHeight,
  reviewerPickerSide,
  selectedReviewerLogins,
  setActiveReviewerIndex,
  setReviewerInput,
  setReviewerInputNode,
  submitting,
  suggestedReviewerRows
}: ReviewerPickerProps): React.JSX.Element {
  const renderReviewerPickerRow = (
    reviewer: GitHubAssignableUser,
    options: {
      suggested: boolean
      activeIndex: number
    }
  ): React.JSX.Element => {
    const selected = selectedReviewerLogins.has(reviewer.login.toLowerCase())
    const active = actionableReviewerRows[activeReviewerIndex]?.login === reviewer.login
    return (
      <button
        key={`${options.suggested ? 'suggested' : 'reviewer'}:${reviewer.login}`}
        type="button"
        className={cn(
          'flex min-h-10 w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-[13px] outline-none last:border-b-0 hover:bg-accent/70',
          active && 'bg-accent text-accent-foreground',
          selected && 'font-medium'
        )}
        onMouseEnter={() => setActiveReviewerIndex(options.activeIndex)}
        onMouseDown={(event) => {
          event.preventDefault()
          void requestReviewer(reviewer)
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
          {selected ? <Check className="size-3.5" /> : null}
        </span>
        <GitHubUserAvatar
          login={reviewer.login}
          name={reviewer.name}
          avatarUrl={reviewer.avatarUrl}
          className="size-5"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <span className="font-semibold text-foreground">{reviewer.login}</span>
            {reviewer.name ? (
              <span className="ml-1 font-normal text-muted-foreground">{reviewer.name}</span>
            ) : null}
          </span>
          {options.suggested ? (
            <span className="block truncate text-[12px] leading-4 text-muted-foreground">
              {translate(
                'auto.components.TaskPage.5d4fd69a6a',
                'Recently active in this pull request'
              )}
            </span>
          ) : null}
        </span>
      </button>
    )
  }

  return (
    <PopoverContent
      className="flex w-[330px] flex-col overflow-hidden rounded-md border-border/70 p-0"
      align="start"
      side={reviewerPickerSide}
      sideOffset={6}
      avoidCollisions={false}
      style={{
        maxHeight: reviewerPickerMaxHeight ? `${reviewerPickerMaxHeight}px` : undefined
      }}
      onClick={(event) => event.stopPropagation()}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
      }}
    >
      <div className="border-b border-border/70 px-3 py-2">
        <div className="text-[13px] font-semibold text-foreground">
          {translate('auto.components.TaskPage.62c7bd789f', 'Request up to 15 reviewers')}
        </div>
      </div>
      <div className="border-b border-border/70 p-3">
        <Input
          ref={setReviewerInputNode}
          value={reviewerInput}
          onChange={(event) => setReviewerInput(event.target.value)}
          placeholder={translate('auto.components.TaskPage.0b9b04f4b5', 'Type or choose a user')}
          disabled={!repo || submitting}
          className="h-8 rounded-md bg-background px-2 text-[13px]"
          aria-label={translate('auto.components.TaskPage.0b9b04f4b5', 'Type or choose a user')}
          aria-autocomplete="list"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && actionableReviewerRows.length > 0) {
              event.preventDefault()
              setActiveReviewerIndex((current) => (current + 1) % actionableReviewerRows.length)
              return
            }
            if (event.key === 'ArrowUp' && actionableReviewerRows.length > 0) {
              event.preventDefault()
              setActiveReviewerIndex(
                (current) =>
                  (current - 1 + actionableReviewerRows.length) % actionableReviewerRows.length
              )
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const activeReviewer = actionableReviewerRows[activeReviewerIndex]
              if (activeReviewer) {
                void requestReviewer(activeReviewer)
                return
              }
              void handleRequestReview()
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              handleReviewerPickerOpenChange(false)
            }
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {reviewerMetadataLoading ? (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">
            {translate('auto.components.TaskPage.0eacf48491', 'Loading…')}
          </div>
        ) : filteredReviewerCandidates.length > 0 ? (
          <>
            {suggestedReviewerRows.length > 0 ? (
              <>
                <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
                  {translate('auto.components.TaskPage.3ace2e6bcf', 'Suggestions')}
                </div>
                {suggestedReviewerRows.map((reviewer, index) =>
                  renderReviewerPickerRow(reviewer, {
                    suggested: true,
                    activeIndex: index
                  })
                )}
              </>
            ) : null}
            <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
              {translate('auto.components.TaskPage.67755a83a1', 'Everyone else')}
            </div>
            {everyoneElseReviewerRows.length > 0 ? (
              everyoneElseReviewerRows.map((reviewer, index) =>
                renderReviewerPickerRow(reviewer, {
                  suggested: false,
                  activeIndex: suggestedReviewerRows.length + index
                })
              )
            ) : (
              <div className="px-3 py-2 text-[13px] text-muted-foreground">
                {translate('auto.components.TaskPage.8a22eb3f7b', 'No matching reviewers.')}
              </div>
            )}
          </>
        ) : (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">
            {reviewerMetadataError ??
              (hasReviewerMetadata
                ? translate('auto.components.TaskPage.8a22eb3f7b', 'No matching reviewers.')
                : translate(
                    'auto.components.TaskPage.9e03c17847',
                    'Open the PR details to view current reviewers.'
                  ))}
          </div>
        )}
      </div>
    </PopoverContent>
  )
}
