import React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

export function PRReviewerPickerRow({
  reviewer,
  suggested,
  selected,
  active,
  onHover,
  onFocusIndex,
  onToggle
}: {
  reviewer: GitHubAssignableUser
  suggested: boolean
  selected: boolean
  active: boolean
  onHover: () => void
  onFocusIndex: () => void
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      key={`${suggested ? 'suggested' : 'reviewer'}:${reviewer.login}`}
      type="button"
      aria-label={
        selected
          ? translate(
              'auto.components.GitHubItemDialog.fedc09eeb9',
              'Unrequest reviewer {{value0}}',
              {
                value0: reviewer.login
              }
            )
          : translate(
              'auto.components.GitHubItemDialog.8c45901789',
              'Request reviewer {{value0}}',
              {
                value0: reviewer.login
              }
            )
      }
      aria-pressed={selected}
      className={cn(
        'flex min-h-10 w-full items-center gap-2 border-b border-border/70 px-3 py-2 text-left text-[13px] outline-none last:border-b-0 hover:bg-accent/70 focus-visible:bg-accent focus-visible:text-accent-foreground',
        active && 'bg-accent text-accent-foreground',
        selected && 'font-medium'
      )}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        event.preventDefault()
      }}
      onFocus={onFocusIndex}
      onClick={onToggle}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
        {selected ? <Check className="size-3.5" /> : null}
      </span>
      {reviewer.avatarUrl ? (
        <img src={reviewer.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
          {reviewer.login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <span className="font-semibold text-foreground">{reviewer.login}</span>
          {reviewer.name ? (
            <span className="ml-1 font-normal text-muted-foreground">{reviewer.name}</span>
          ) : null}
        </span>
        {suggested ? (
          <span className="block truncate text-[12px] leading-4 text-muted-foreground">
            {translate(
              'auto.components.GitHubItemDialog.e3243d9376',
              'Recently edited these files'
            )}
          </span>
        ) : null}
      </span>
    </button>
  )
}

export function PRReviewersPickerList({
  loading,
  error,
  hasReviewerMetadata,
  filteredReviewerCandidates,
  suggestedReviewerRows,
  everyoneElseReviewerRows,
  selectedReviewerLogins,
  activeReviewerIndex,
  actionableReviewerRows,
  onHover,
  onFocus,
  onSelect
}: {
  loading: boolean
  error?: string | null
  hasReviewerMetadata: boolean
  filteredReviewerCandidates: GitHubAssignableUser[]
  suggestedReviewerRows: GitHubAssignableUser[]
  everyoneElseReviewerRows: GitHubAssignableUser[]
  selectedReviewerLogins: Set<string>
  activeReviewerIndex: number
  actionableReviewerRows: GitHubAssignableUser[]
  onHover: (index: number) => void
  onFocus: (index: number) => void
  onSelect: (reviewer: GitHubAssignableUser) => void
}): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
      {loading ? (
        <div className="px-3 py-2 text-[13px] text-muted-foreground">
          {translate('auto.components.GitHubItemDialog.a98433e73d', 'Loading...')}
        </div>
      ) : filteredReviewerCandidates.length > 0 ? (
        <>
          {suggestedReviewerRows.length > 0 ? (
            <>
              <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
                {translate('auto.components.GitHubItemDialog.c2b21818e1', 'Suggestions')}
              </div>
              {suggestedReviewerRows.map((reviewer, index) => (
                <PRReviewerPickerRow
                  key={`suggested:${reviewer.login}`}
                  reviewer={reviewer}
                  suggested
                  selected={selectedReviewerLogins.has(reviewer.login.toLowerCase())}
                  active={actionableReviewerRows[activeReviewerIndex]?.login === reviewer.login}
                  onHover={() => onHover(index)}
                  onFocusIndex={() => onFocus(index)}
                  onToggle={() => onSelect(reviewer)}
                />
              ))}
            </>
          ) : null}
          <div className="border-b border-border/70 bg-muted/50 px-3 py-1.5 text-[12px] font-semibold text-foreground">
            {translate('auto.components.GitHubItemDialog.1ffce94a8b', 'Everyone else')}
          </div>
          {everyoneElseReviewerRows.length > 0 ? (
            everyoneElseReviewerRows.map((reviewer, index) => (
              <PRReviewerPickerRow
                key={`reviewer:${reviewer.login}`}
                reviewer={reviewer}
                suggested={false}
                selected={selectedReviewerLogins.has(reviewer.login.toLowerCase())}
                active={actionableReviewerRows[activeReviewerIndex]?.login === reviewer.login}
                onHover={() => onHover(suggestedReviewerRows.length + index)}
                onFocusIndex={() => onFocus(suggestedReviewerRows.length + index)}
                onToggle={() => onSelect(reviewer)}
              />
            ))
          ) : (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">
              {translate('auto.components.GitHubItemDialog.70e84e3d0b', 'No matching reviewers.')}
            </div>
          )}
        </>
      ) : (
        <div className="px-3 py-2 text-[13px] text-muted-foreground">
          {error ??
            (hasReviewerMetadata
              ? translate('auto.components.GitHubItemDialog.70e84e3d0b', 'No matching reviewers.')
              : translate(
                  'auto.components.GitHubItemDialog.3f79ffc8b7',
                  'Open the PR details to view current reviewers.'
                ))}
        </div>
      )}
    </div>
  )
}
