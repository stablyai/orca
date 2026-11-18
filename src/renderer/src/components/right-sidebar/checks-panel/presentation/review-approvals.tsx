import React, { useState } from 'react'
import { ChevronDown, CircleCheck, CircleX, Clock, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { PRReviewerRow } from '@/components/github/pr-reviewer-row'
import { CHECK_COLOR } from './check-presentation'
import {
  getGitHubPRReviewerRows,
  type GitHubPRReviewerRow
} from '../../../../../../shared/github/pull-requests/pr-reviewer-display'
import type { PRInfo } from '../../../../../../shared/github/pull-requests/pull-request-types'

const REVIEWER_STATE_ORDER: Record<string, number> = {
  CHANGES_REQUESTED: 0,
  APPROVED: 1,
  REQUESTED: 2
}

function reviewerOrder(reviewer: GitHubPRReviewerRow): number {
  return REVIEWER_STATE_ORDER[reviewer.state ?? ''] ?? 3
}

export function ChecksPanelReviewApprovals({ pr }: { pr: PRInfo }): React.JSX.Element | null {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(true)
  // Either list unknown means a pending or approving reviewer could be missing; claim nothing.
  if (pr.reviewRequests === undefined || pr.latestReviews === undefined) {
    return null
  }
  const reviewers = getGitHubPRReviewerRows(pr).toSorted(
    (a, b) => reviewerOrder(a) - reviewerOrder(b)
  )
  const unnamedRequestCount = pr.unnamedReviewRequestCount ?? 0
  if (reviewers.length === 0 && unnamedRequestCount === 0) {
    return (
      <div className="border-b border-border px-3 py-2 text-3xs text-muted-foreground">
        {t(
          'auto.components.right.sidebar.checks.panel.reviews.noReviewers',
          'No reviewers requested'
        )}
      </div>
    )
  }
  const countByState = (state: string): number =>
    reviewers.filter((reviewer) => reviewer.state === state).length
  const approvedCount = countByState('APPROVED')
  const changesRequestedCount = countByState('CHANGES_REQUESTED')
  const requestedCount = countByState('REQUESTED') + unnamedRequestCount
  const commentedCount = countByState('COMMENTED')
  const hasStateCounts = approvedCount + changesRequestedCount + requestedCount + commentedCount > 0
  return (
    <div className="border-b border-border">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-3 py-2 text-left text-3xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <ChevronDown
          className={cn('size-3 shrink-0 transition-transform', !expanded && '-rotate-90')}
        />
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {approvedCount > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <CircleCheck className={cn('size-3', CHECK_COLOR.success)} />
              {t(
                'auto.components.right.sidebar.checks.panel.reviews.approvedCount',
                '{{count}} approved',
                {
                  count: approvedCount,
                  defaultValue_one: '{{count}} approved'
                }
              )}
            </span>
          )}
          {changesRequestedCount > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <CircleX className={cn('size-3', CHECK_COLOR.failure)} />
              {t(
                'auto.components.right.sidebar.checks.panel.reviews.changesRequestedCount',
                '{{count}} requested changes',
                { count: changesRequestedCount, defaultValue_one: '{{count}} requested changes' }
              )}
            </span>
          )}
          {requestedCount > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <Clock className={cn('size-3', CHECK_COLOR.pending)} />
              {t(
                'auto.components.right.sidebar.checks.panel.reviews.requestedCount',
                '{{count}} requested',
                { count: requestedCount, defaultValue_one: '{{count}} requested' }
              )}
            </span>
          )}
          {commentedCount > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <MessageSquare className="size-3" />
              {t(
                'auto.components.right.sidebar.checks.panel.reviews.commentedCount',
                '{{count}} commented',
                { count: commentedCount, defaultValue_one: '{{count}} commented' }
              )}
            </span>
          )}
          {!hasStateCounts && (
            <span>
              {t(
                'auto.components.right.sidebar.checks.panel.reviews.reviewerCount',
                '{{count}} reviewers',
                { count: reviewers.length, defaultValue_one: '{{count}} reviewer' }
              )}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-2 px-3 pt-1 pb-2.5">
          {reviewers.map((reviewer) => (
            <PRReviewerRow key={reviewer.login} reviewer={reviewer} />
          ))}
          {unnamedRequestCount > 0 && (
            <div className={cn('text-2xs text-muted-foreground', reviewers.length > 0 && 'pl-8')}>
              {reviewers.length > 0
                ? t(
                    'auto.components.right.sidebar.checks.panel.reviews.unnamedRequestCount',
                    '{{count}} more requested reviewers',
                    {
                      count: unnamedRequestCount,
                      defaultValue_one: '{{count}} more requested reviewer'
                    }
                  )
                : t(
                    'auto.components.right.sidebar.checks.panel.reviews.onlyUnnamedRequestCount',
                    '{{count}} requested reviewers GitHub does not name',
                    {
                      count: unnamedRequestCount,
                      defaultValue_one: '{{count}} requested reviewer GitHub does not name'
                    }
                  )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
