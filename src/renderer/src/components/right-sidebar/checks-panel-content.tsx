/* eslint-disable max-lines -- Why: co-locating all checks-panel sub-components (checks list,
conflict sections, threaded PR comments) keeps the shared icon/color maps in one place. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  CircleDashed,
  CircleMinus,
  GitPullRequest,
  Files,
  Copy,
  Check,
  MessageSquare,
  Plus,
  ChevronDown,
  ChevronRight,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  MoreHorizontal,
  Pencil,
  Trash
} from 'lucide-react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  getPRCommentAudienceEmptyLabel,
  isBotPRComment,
  getPrCommentAudienceFilters,
  type PRCommentAudienceFilter
} from '@/lib/pr-comment-audience'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  groupPRComments,
  isResolvedPRCommentGroup,
  PR_COMMENT_OPEN_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_CONTAINER_CLASS,
  type PRCommentGroup
} from '@/lib/pr-comment-groups'
import type {
  PRInfo,
  PRCheckDetail,
  PRCheckRunDetails,
  PRComment,
  PRConflictSummary,
  PRMergeableState
} from '../../../../shared/types'
import { useCheckDetailsResize } from './check-details-resize'
import {
  RightPanelCommentComposer,
  type RightPanelCommentSubmitResult
} from './right-panel-comment-composer'
import { translate } from '@/i18n/i18n'

export const PullRequestIcon = GitPullRequest

export const CHECK_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  success: CircleCheck,
  failure: CircleX,
  pending: LoaderCircle,
  neutral: CircleDashed,
  skipped: CircleMinus,
  cancelled: CircleX,
  timed_out: CircleX
}

export const CHECK_COLOR: Record<string, string> = {
  success: 'text-emerald-500',
  failure: 'text-rose-500',
  pending: 'text-amber-500',
  neutral: 'text-muted-foreground',
  skipped: 'text-muted-foreground/60',
  cancelled: 'text-muted-foreground/60',
  timed_out: 'text-rose-500'
}

type ConflictReview = {
  mergeable: PRMergeableState
  conflictSummary?: PRConflictSummary
}

export function ConflictingFilesSection({ pr }: { pr: ConflictReview }): React.JSX.Element | null {
  const files = pr.conflictSummary?.files ?? []
  if (pr.mergeable !== 'CONFLICTING' || files.length === 0) {
    return null
  }

  // Why: the resolve action lives in the triage strip above; this section is
  // purely the informational conflict file list so the action isn't duplicated.
  return (
    <div className="border-b border-border px-3 py-3">
      <div className="text-[11px] text-muted-foreground">
        {pr.conflictSummary!.commitsBehind}{' '}
        {translate('auto.components.right.sidebar.checks.panel.content.6fa7f8723f', 'commit')}
        {pr.conflictSummary!.commitsBehind === 1 ? '' : 's'}{' '}
        {translate(
          'auto.components.right.sidebar.checks.panel.content.3916814392',
          'behind (base commit:'
        )}{' '}
        <span className="font-mono text-[10px]">{pr.conflictSummary!.baseCommit}</span>)
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Files className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.0975eeaaef',
            'Conflicting files'
          )}
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {files.map((filePath) => (
          <div
            key={filePath}
            className="rounded-md border border-border bg-accent/20 px-2.5 py-1.5"
          >
            <div className="break-all font-mono text-[11px] leading-4 text-foreground">
              {filePath}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Fallback shown when the hosted review reports merge conflicts but no file list is available yet. */
export function MergeConflictNotice({
  pr,
  isRefreshingConflictDetails
}: {
  pr: ConflictReview
  isRefreshingConflictDetails: boolean
}): React.JSX.Element | null {
  if (pr.mergeable !== 'CONFLICTING' || (pr.conflictSummary?.files.length ?? 0) > 0) {
    return null
  }

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="text-[11px] font-medium text-foreground">
        {translate(
          'auto.components.right.sidebar.checks.panel.content.87cd07c69a',
          'This branch has conflicts that must be resolved'
        )}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {isRefreshingConflictDetails
          ? translate(
              'auto.components.right.sidebar.checks.panel.content.73d0675356',
              'Refreshing conflict details…'
            )
          : translate(
              'auto.components.right.sidebar.checks.panel.content.ae8a04ef17',
              'Conflict file details are unavailable'
            )}
      </div>
    </div>
  )
}

export function PRTriageStrip({
  review,
  pr,
  reviewKind = 'PR',
  checks,
  isResolvingConflictsWithAI,
  onResolveConflictsWithAI,
  resolveConflictsDisabled,
  resolveConflictsDisabledReason,
  isFixingChecksWithAI,
  onFixChecksWithAI,
  fixChecksDisabled,
  fixChecksDisabledReason
}: {
  review?: ConflictReview
  pr?: ConflictReview
  reviewKind?: 'PR' | 'MR'
  checks: PRCheckDetail[]
  isResolvingConflictsWithAI: boolean
  onResolveConflictsWithAI: () => void
  resolveConflictsDisabled?: boolean
  resolveConflictsDisabledReason?: string
  isFixingChecksWithAI: boolean
  onFixChecksWithAI: () => void
  fixChecksDisabled?: boolean
  fixChecksDisabledReason?: string
}): React.JSX.Element {
  const resolvedReview = review ?? pr
  const failingCount = checks.filter((check) => isFailedCheck(check)).length
  const pendingCount = checks.filter(
    (check) => check.conclusion === 'pending' || check.conclusion === null
  ).length

  if (resolvedReview?.mergeable === 'CONFLICTING') {
    return (
      <ConflictTriageStrip
        reviewKind={reviewKind}
        isResolvingConflictsWithAI={isResolvingConflictsWithAI}
        onResolveConflictsWithAI={onResolveConflictsWithAI}
        resolveConflictsDisabled={resolveConflictsDisabled}
        resolveConflictsDisabledReason={resolveConflictsDisabledReason}
      />
    )
  }

  if (failingCount > 0) {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <CircleX className="size-3.5 shrink-0 text-rose-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-foreground">
              {failingCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.b652f38caf',
                'failing check'
              )}
              {failingCount === 1 ? '' : 's'}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.5d4ebf9391',
                'Inspect details or start an AI fix pass.'
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={isFixingChecksWithAI || fixChecksDisabled}
            title={fixChecksDisabled ? fixChecksDisabledReason : undefined}
            onClick={onFixChecksWithAI}
          >
            {isFixingChecksWithAI ? (
              <RefreshCw className="size-3 animate-spin" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {translate('auto.components.right.sidebar.checks.panel.content.b45db92d0e', 'Fix')}
          </Button>
        </div>
      </div>
    )
  }

  if (pendingCount > 0) {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-foreground">
              {pendingCount}{' '}
              {translate('auto.components.right.sidebar.checks.panel.content.5341023167', 'check')}
              {pendingCount === 1 ? '' : 's'}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.9ad98f2a17',
                'pending'
              )}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.5856874b59',
                'Orca will refresh checks while this panel stays open.'
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.9d0e7bcefc',
              'No blocking PR action'
            )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.c16762ac8c',
              'Checks and comments below show the current fetched context.'
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ConflictTriageStrip({
  reviewKind,
  isResolvingConflictsWithAI,
  onResolveConflictsWithAI,
  resolveConflictsDisabled,
  resolveConflictsDisabledReason
}: {
  reviewKind: 'PR' | 'MR'
  isResolvingConflictsWithAI: boolean
  onResolveConflictsWithAI: () => void
  resolveConflictsDisabled?: boolean
  resolveConflictsDisabledReason?: string
}): React.JSX.Element {
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.60186d8498',
              'Conflicts block this'
            )}{' '}
            {reviewKind}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.3a71a6ed0b',
              'Resolve conflicts before checks and merge can complete.'
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="default"
          size="xs"
          disabled={isResolvingConflictsWithAI || resolveConflictsDisabled}
          title={resolveConflictsDisabled ? resolveConflictsDisabledReason : undefined}
          onClick={onResolveConflictsWithAI}
        >
          {isResolvingConflictsWithAI ? (
            <RefreshCw className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          {translate('auto.components.right.sidebar.checks.panel.content.0c96cd25e5', 'Resolve')}
        </Button>
      </div>
    </div>
  )
}

const CHECK_SORT_ORDER: Record<string, number> = {
  failure: 0,
  timed_out: 0,
  cancelled: 1,
  pending: 2,
  neutral: 3,
  skipped: 4,
  success: 5
}

type CheckDetailsLoadState = {
  loading: boolean
  details: PRCheckRunDetails | null
  error: string | null
}

function getCheckIdentityKey(check: PRCheckDetail, index: number): string {
  if (check.checkRunId) {
    return `check-run:${check.checkRunId}`
  }
  if (check.workflowRunId) {
    return `workflow-run:${check.workflowRunId}`
  }
  if (check.url) {
    return `url:${check.url}`
  }
  return `fallback:${check.name}:${index}`
}

function getCheckDetailsKey(contextKey: string, check: PRCheckDetail, index: number): string {
  return `${contextKey}::${getCheckIdentityKey(check, index)}`
}

function getCheckConclusion(check: PRCheckDetail): NonNullable<PRCheckDetail['conclusion']> {
  return check.conclusion ?? 'pending'
}

function isFailedCheck(check: PRCheckDetail): boolean {
  return ['failure', 'cancelled', 'timed_out'].includes(getCheckConclusion(check))
}

function isFailureState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

function getCheckStatusLabel(check: PRCheckDetail): string {
  const conclusion = getCheckConclusion(check)
  if (conclusion === 'success') {
    return 'Successful'
  }
  if (conclusion === 'failure') {
    return 'Failed'
  }
  if (conclusion === 'cancelled') {
    return 'Cancelled'
  }
  if (conclusion === 'timed_out') {
    return 'Timed out'
  }
  if (conclusion === 'neutral') {
    return 'Neutral'
  }
  if (conclusion === 'skipped') {
    return 'Skipped'
  }
  if (check.status === 'queued') {
    return 'Queued'
  }
  if (check.status === 'in_progress') {
    return 'In progress'
  }
  return 'Pending'
}

function formatCheckTimestamp(input: string | null | undefined): string | null {
  if (!input) {
    return null
  }
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function getFailedChecksForDetails(checks: PRCheckDetail[]): PRCheckDetail[] {
  return checks.filter(isFailedCheck)
}

function CheckRunDetails({
  check,
  state
}: {
  check: PRCheckDetail
  state: CheckDetailsLoadState | undefined
}): React.JSX.Element {
  const details = state?.details
  const openUrl = details?.detailsUrl ?? details?.url ?? check.url
  const startedAt = formatCheckTimestamp(details?.startedAt)
  const completedAt = formatCheckTimestamp(details?.completedAt)
  const detailsStatusCheck: PRCheckDetail = {
    ...check,
    status: (details?.status as PRCheckDetail['status'] | undefined) ?? check.status,
    conclusion: (details?.conclusion as PRCheckDetail['conclusion'] | undefined) ?? check.conclusion
  }
  const failedJobs =
    details?.jobs.filter((job) => {
      const state = job.conclusion ?? job.status
      return isFailureState(state)
    }) ?? []
  const jobs = failedJobs.length > 0 ? failedJobs : (details?.jobs ?? [])
  const hasOutput = Boolean(details?.title || details?.summary || details?.text)
  const hasAnnotations = (details?.annotations.length ?? 0) > 0
  const hasJobs = jobs.length > 0
  const hasLogTail = jobs.some((job) => Boolean(job.logTail))

  return (
    <div className="mb-1 ml-[26px] mr-3 min-w-0 border-l border-border pl-3">
      {state?.loading ? (
        <div className="flex items-center gap-2 py-1.5 text-[12px] text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          {translate(
            'auto.components.right.sidebar.checks.panel.content.1f2b980522',
            'Loading check details…'
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              {translate(
                'auto.components.right.sidebar.checks.panel.content.a54ae21c6f',
                'Status:'
              )}{' '}
              {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
            </span>
            {startedAt && (
              <span>
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.fd46a70f1a',
                  'Started'
                )}
                {startedAt}
              </span>
            )}
            {completedAt && (
              <span>
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.00e1c1658a',
                  'Completed'
                )}
                {completedAt}
              </span>
            )}
            {check.checkRunId && (
              <span className="font-mono">
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.aa8494ae3c',
                  'check #'
                )}
                {check.checkRunId}
              </span>
            )}
            {check.workflowRunId && (
              <span className="font-mono">
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.2dd5ddabc4',
                  'workflow #'
                )}
                {check.workflowRunId}
              </span>
            )}
          </div>

          {state?.error && <div className="text-[12px] text-muted-foreground">{state.error}</div>}

          {hasOutput && (
            <div className="min-w-0">
              {details?.title && (
                <div className="mb-1 text-[12px] font-medium text-foreground">{details.title}</div>
              )}
              {details?.summary && (
                <CommentMarkdown
                  content={details.summary}
                  variant="document"
                  className="min-w-0 max-w-full overflow-hidden break-words text-[12px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                />
              )}
              {details?.text && (
                <CommentMarkdown
                  content={details.text}
                  variant="document"
                  className="mt-2 min-w-0 max-w-full overflow-hidden break-words text-[12px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                />
              )}
            </div>
          )}

          {hasAnnotations && (
            <div className="min-w-0 border-t border-border/60 pt-2">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.f2fe8a4e8f',
                  'Annotations'
                )}
              </div>
              <div className="flex flex-col gap-2">
                {details!.annotations.map((annotation, index) => (
                  <div key={`${annotation.path ?? 'annotation'}-${index}`} className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                        {annotation.path ??
                          translate(
                            'auto.components.right.sidebar.checks.panel.content.cdbfda4dec',
                            'Annotation'
                          )}
                        {annotation.startLine ? `:${annotation.startLine}` : ''}
                      </span>
                      {annotation.annotationLevel && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {annotation.annotationLevel}
                        </span>
                      )}
                    </div>
                    {annotation.title && (
                      <div className="mt-0.5 text-[12px] font-medium text-foreground">
                        {annotation.title}
                      </div>
                    )}
                    <div className="mt-0.5 break-words text-[12px] text-foreground">
                      {annotation.message}
                    </div>
                    {annotation.rawDetails && (
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
                        {annotation.rawDetails}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
              {details!.annotations.length >= 20 && (
                <div className="mt-1.5 text-[10px] text-muted-foreground">
                  {translate(
                    'auto.components.right.sidebar.checks.panel.content.df137989b3',
                    'Showing first 20 annotations'
                  )}
                </div>
              )}
            </div>
          )}

          {hasJobs && (
            <div className="min-w-0 border-t border-border/60 pt-2">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {failedJobs.length > 0
                  ? translate(
                      'auto.components.right.sidebar.checks.panel.content.066fedd446',
                      'Failed jobs'
                    )
                  : translate(
                      'auto.components.right.sidebar.checks.panel.content.49731703ea',
                      'Jobs'
                    )}
              </div>
              <div className="flex flex-col gap-2">
                {jobs.map((job, index) => (
                  <div key={`${job.name}-${index}`} className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                        {job.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {job.conclusion ??
                          job.status ??
                          translate(
                            'auto.components.right.sidebar.checks.panel.content.ee07b33924',
                            'unknown'
                          )}
                      </span>
                    </div>
                    {job.steps.length > 0 && (
                      <div className="mt-1 grid gap-0.5 pl-2">
                        {job.steps
                          .filter((step) => {
                            const state = step.conclusion ?? step.status
                            return isFailureState(state)
                          })
                          .map((step) => (
                            <div
                              key={step.name}
                              className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground"
                            >
                              <span className="min-w-0 flex-1 truncate">{step.name}</span>
                              <span className="shrink-0">{step.conclusion ?? step.status}</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {(details?.jobs.length ?? 0) >= 100 && (
                <div className="mt-1.5 text-[10px] text-muted-foreground">
                  {translate(
                    'auto.components.right.sidebar.checks.panel.content.a2fb3f4408',
                    'Showing first 100 jobs'
                  )}
                </div>
              )}
            </div>
          )}

          {hasLogTail && (
            <div className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.2524d1fb83',
                'Log tail available in full details.'
              )}
            </div>
          )}

          {!state?.error && !hasOutput && !hasAnnotations && !hasJobs && (
            <div className="text-[12px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
                'No inline details are available for this check.'
              )}
            </div>
          )}

          <div className="flex justify-end pt-1">
            {!state?.loading && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {translate(
                      'auto.components.right.sidebar.checks.panel.content.e4e3af15ee',
                      'View full details'
                    )}
                  </Button>
                </DialogTrigger>
                <CheckRunDetailsDialog
                  check={check}
                  state={state}
                  detailsStatusCheck={detailsStatusCheck}
                  jobs={jobs}
                  openUrl={openUrl}
                />
              </Dialog>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function CheckRunDetailsDialog({
  check,
  state,
  detailsStatusCheck,
  jobs,
  openUrl
}: {
  check: PRCheckDetail
  state: CheckDetailsLoadState | undefined
  detailsStatusCheck: PRCheckDetail
  jobs: NonNullable<PRCheckRunDetails['jobs']>
  openUrl: string | null | undefined
}): React.JSX.Element {
  const details = state?.details
  const startedAt = formatCheckTimestamp(details?.startedAt)
  const completedAt = formatCheckTimestamp(details?.completedAt)
  const hasOutput = Boolean(details?.title || details?.summary || details?.text)
  const hasAnnotations = (details?.annotations.length ?? 0) > 0
  const hasJobs = jobs.length > 0

  return (
    <DialogContent
      className="flex max-h-[85vh] w-[min(760px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
      onClick={(event) => event.stopPropagation()}
    >
      <DialogHeader className="border-b border-border px-5 py-4 pr-12">
        <DialogTitle className="truncate text-base">{check.name}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span>
            {translate('auto.components.right.sidebar.checks.panel.content.a54ae21c6f', 'Status:')}
            {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
          </span>
          {startedAt && (
            <span>
              {translate(
                'auto.components.right.sidebar.checks.panel.content.fd46a70f1a',
                'Started'
              )}
              {startedAt}
            </span>
          )}
          {completedAt && (
            <span>
              {translate(
                'auto.components.right.sidebar.checks.panel.content.00e1c1658a',
                'Completed'
              )}
              {completedAt}
            </span>
          )}
          {check.checkRunId && (
            <span className="font-mono">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.aa8494ae3c',
                'check #'
              )}
              {check.checkRunId}
            </span>
          )}
          {check.workflowRunId && (
            <span className="font-mono">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.2dd5ddabc4',
                'workflow #'
              )}
              {check.workflowRunId}
            </span>
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-sleek">
        <div className="grid gap-4">
          {state?.error && <div className="text-sm text-muted-foreground">{state.error}</div>}

          {hasOutput && (
            <section className="rounded-md border border-border bg-background">
              <div className="border-b border-border px-3 py-2 text-sm font-medium">
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.d098e5529a',
                  'Output'
                )}
              </div>
              <div className="px-3 py-3">
                {details?.title && (
                  <div className="mb-2 text-sm font-medium text-foreground">{details.title}</div>
                )}
                {details?.summary && (
                  <CommentMarkdown
                    content={details.summary}
                    variant="document"
                    className="min-w-0 max-w-full overflow-hidden break-words text-sm leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                  />
                )}
                {details?.text && (
                  <CommentMarkdown
                    content={details.text}
                    variant="document"
                    className="mt-3 min-w-0 max-w-full overflow-hidden break-words text-sm leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                  />
                )}
              </div>
            </section>
          )}

          {hasAnnotations && (
            <section className="rounded-md border border-border bg-background">
              <div className="border-b border-border px-3 py-2 text-sm font-medium">
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.f2fe8a4e8f',
                  'Annotations'
                )}
              </div>
              <div className="divide-y divide-border/50">
                {details!.annotations.map((annotation, index) => (
                  <div key={`${annotation.path ?? 'annotation'}-${index}`} className="px-3 py-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                        {annotation.path ??
                          translate(
                            'auto.components.right.sidebar.checks.panel.content.cdbfda4dec',
                            'Annotation'
                          )}
                        {annotation.startLine ? `:${annotation.startLine}` : ''}
                      </span>
                      {annotation.annotationLevel && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {annotation.annotationLevel}
                        </span>
                      )}
                    </div>
                    {annotation.title && (
                      <div className="mt-2 text-sm font-medium text-foreground">
                        {annotation.title}
                      </div>
                    )}
                    <div className="mt-2 break-words text-sm text-foreground">
                      {annotation.message}
                    </div>
                    {annotation.rawDetails && (
                      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs text-muted-foreground scrollbar-sleek">
                        {annotation.rawDetails}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {hasJobs && (
            <section className="rounded-md border border-border bg-background">
              <div className="border-b border-border px-3 py-2 text-sm font-medium">
                {translate('auto.components.right.sidebar.checks.panel.content.49731703ea', 'Jobs')}
              </div>
              <div className="divide-y divide-border/50">
                {jobs.map((job, index) => (
                  <div key={`${job.name}-${index}`} className="px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {job.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {job.conclusion ??
                          job.status ??
                          translate(
                            'auto.components.right.sidebar.checks.panel.content.ee07b33924',
                            'unknown'
                          )}
                      </span>
                    </div>
                    {job.steps.length > 0 && (
                      <div className="mt-2 grid gap-1">
                        {job.steps.map((step) => (
                          <div
                            key={step.name}
                            className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
                          >
                            <span className="min-w-0 flex-1 truncate">{step.name}</span>
                            <span className="shrink-0">{step.conclusion ?? step.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {job.logTail && <CheckJobLogTail logTail={job.logTail} />}
                  </div>
                ))}
              </div>
            </section>
          )}

          {!state?.error && !hasOutput && !hasAnnotations && !hasJobs && (
            <div className="text-sm text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.07eccfa397',
                'No details are available for this check.'
              )}
            </div>
          )}
        </div>
      </div>
      {openUrl && (
        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              event.stopPropagation()
              window.api.shell.openUrl(openUrl)
            }}
          >
            {translate(
              'auto.components.right.sidebar.checks.panel.content.a916648574',
              'Open details'
            )}
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      )}
    </DialogContent>
  )
}

export function CheckJobLogTail({ logTail }: { logTail: string }): React.JSX.Element {
  return (
    <div className="mt-3 min-w-0">
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.d713f500b2',
            'Log tail (last 200 lines)'
          )}
        </div>
        <CopyButton
          text={logTail}
          title={translate(
            'auto.components.right.sidebar.checks.panel.content.679bf2093c',
            'Copy log tail'
          )}
        />
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs text-muted-foreground scrollbar-sleek">
        {logTail}
      </pre>
    </div>
  )
}

/** Renders the checks summary bar + scrollable check list. */
export function ChecksList({
  checks,
  checksLoading,
  checkDetailsContextKey,
  onLoadCheckDetails
}: {
  checks: PRCheckDetail[]
  checksLoading: boolean
  checkDetailsContextKey: string
  onLoadCheckDetails?: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
}): React.JSX.Element {
  const [checksExpanded, setChecksExpanded] = useState(true)
  const [expandedCheckKeys, setExpandedCheckKeys] = useState<Set<string>>(new Set())
  const [detailsByCheckKey, setDetailsByCheckKey] = useState<Record<string, CheckDetailsLoadState>>(
    {}
  )
  const detailsContextRef = useRef(checkDetailsContextKey)
  const autoExpandedContextRef = useRef<string | null>(null)
  // Why: expanded check details already sit inside the sidebar scroller; keeping
  // the list scroller too creates nested scrollbars around CI annotations.
  const shouldConstrainCheckList = checksExpanded && expandedCheckKeys.size === 0
  const { detailsHeight, handleResizeStart } = useCheckDetailsResize(
    shouldConstrainCheckList && checks.length > 0
  )
  detailsContextRef.current = checkDetailsContextKey
  const sorted = React.useMemo(
    () =>
      [...checks].sort(
        (a, b) =>
          (CHECK_SORT_ORDER[a.conclusion ?? 'pending'] ?? 3) -
          (CHECK_SORT_ORDER[b.conclusion ?? 'pending'] ?? 3)
      ),
    [checks]
  )
  const rows = React.useMemo(
    () =>
      sorted.map((check, index) => ({
        check,
        key: getCheckDetailsKey(checkDetailsContextKey, check, index)
      })),
    [checkDetailsContextKey, sorted]
  )
  const passingCount = checks.filter((c) => c.conclusion === 'success').length
  const failingCount = checks.filter(
    (c) =>
      c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out'
  ).length
  const pendingCount = checks.filter(
    (c) => c.conclusion === 'pending' || c.conclusion === null
  ).length

  useEffect(() => {
    const validKeys = new Set(rows.map((row) => row.key))
    setDetailsByCheckKey((current) => {
      const next: Record<string, CheckDetailsLoadState> = {}
      for (const [key, state] of Object.entries(current)) {
        if (validKeys.has(key)) {
          next[key] = state
        }
      }
      return next
    })
    setExpandedCheckKeys((current) => {
      const next = new Set([...current].filter((key) => validKeys.has(key)))
      if (autoExpandedContextRef.current !== checkDetailsContextKey) {
        const firstFailed = rows.find((row) => isFailedCheck(row.check))
        if (firstFailed) {
          next.add(firstFailed.key)
        }
        autoExpandedContextRef.current = checkDetailsContextKey
      }
      return next
    })
  }, [checkDetailsContextKey, rows])

  const requestCheckDetails = useCallback(
    (row: { check: PRCheckDetail; key: string }) => {
      if (detailsByCheckKey[row.key]?.loading || detailsByCheckKey[row.key]?.details) {
        return
      }
      if (!row.check.checkRunId && !row.check.workflowRunId && !row.check.url) {
        setDetailsByCheckKey((current) => ({
          ...current,
          [row.key]: {
            loading: false,
            details: null,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
              'No inline details are available for this check.'
            )
          }
        }))
        return
      }
      if (!onLoadCheckDetails) {
        setDetailsByCheckKey((current) => ({
          ...current,
          [row.key]: {
            loading: false,
            details: null,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
              'No inline details are available for this check.'
            )
          }
        }))
        return
      }
      const requestContextKey = checkDetailsContextKey
      setDetailsByCheckKey((current) => ({
        ...current,
        [row.key]: { loading: true, details: null, error: null }
      }))
      void onLoadCheckDetails(row.check)
        .then((details) => {
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => ({
            ...current,
            [row.key]: {
              loading: false,
              details,
              error: details ? null : 'No inline details are available for this check.'
            }
          }))
        })
        .catch((err) => {
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => ({
            ...current,
            [row.key]: {
              loading: false,
              details: null,
              error: err instanceof Error ? err.message : 'Failed to load check details.'
            }
          }))
        })
    },
    [checkDetailsContextKey, detailsByCheckKey, onLoadCheckDetails]
  )

  useEffect(() => {
    if (!checksExpanded) {
      return
    }
    for (const row of rows) {
      if (expandedCheckKeys.has(row.key) && !detailsByCheckKey[row.key]) {
        requestCheckDetails(row)
      }
    }
  }, [checksExpanded, detailsByCheckKey, expandedCheckKeys, requestCheckDetails, rows])

  const toggleCheckExpanded = useCallback(
    (row: { check: PRCheckDetail; key: string }) => {
      const willExpand = !expandedCheckKeys.has(row.key)
      setExpandedCheckKeys((current) => {
        const next = new Set(current)
        if (next.has(row.key)) {
          next.delete(row.key)
        } else {
          next.add(row.key)
        }
        return next
      })
      if (willExpand) {
        requestCheckDetails(row)
      }
    },
    [expandedCheckKeys, requestCheckDetails]
  )

  return (
    <>
      {/* Checks Summary */}
      {checks.length > 0 && (
        <button
          type="button"
          className="flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          onClick={() => setChecksExpanded((expanded) => !expanded)}
          aria-expanded={checksExpanded}
        >
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', !checksExpanded && '-rotate-90')}
          />
          {passingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleCheck className="size-3 text-emerald-500" />
              {passingCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.02ca4f9074',
                'passing'
              )}
            </span>
          )}
          {failingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleX className="size-3 text-rose-500" />
              {failingCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.5e52f4ef7f',
                'failing'
              )}
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <LoaderCircle className="size-3 text-amber-500" />
              {pendingCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.9ad98f2a17',
                'pending'
              )}
            </span>
          )}
          <span className="flex-1" />
          {checksLoading && <LoaderCircle className="size-3 animate-spin text-muted-foreground" />}
        </button>
      )}

      {/* Checks List */}
      {checksLoading && checks.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : checks.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.991f50c7e4',
            'No checks configured'
          )}
        </div>
      ) : !checksExpanded ? null : (
        <>
          <div
            className={cn('py-1', shouldConstrainCheckList && 'overflow-y-auto scrollbar-sleek')}
            style={shouldConstrainCheckList ? { maxHeight: detailsHeight } : undefined}
          >
            {rows.map((row) => {
              const check = row.check
              const conclusion = check.conclusion ?? 'pending'
              const Icon = CHECK_ICON[conclusion] ?? CircleDashed
              const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
              const expanded = expandedCheckKeys.has(row.key)
              const openUrl = check.url
              return (
                <div key={row.key} className="min-w-0">
                  <div
                    className={cn(
                      'group/check-row flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/40',
                      expanded && 'bg-accent/25'
                    )}
                    onClick={() => toggleCheckExpanded(row)}
                  >
                    <ChevronRight
                      className={cn(
                        'size-3 shrink-0 text-muted-foreground transition-transform',
                        expanded && 'rotate-90'
                      )}
                    />
                    <Icon
                      className={cn(
                        'size-3.5 shrink-0',
                        color,
                        conclusion === 'pending' && 'animate-spin'
                      )}
                    />
                    <span className="flex-1 truncate text-[12px] text-foreground">
                      {check.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="text-[11px] text-muted-foreground">
                        {getCheckStatusLabel(check)}
                      </span>
                      {openUrl && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="size-6 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                              aria-label={translate(
                                'auto.components.right.sidebar.checks.panel.content.0dca6bfab5',
                                'Open check details'
                              )}
                              onClick={(event) => {
                                event.stopPropagation()
                                window.api.shell.openUrl(openUrl)
                              }}
                            >
                              <ExternalLink className="size-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left" sideOffset={4}>
                            {translate(
                              'auto.components.right.sidebar.checks.panel.content.0dca6bfab5',
                              'Open check details'
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </div>
                  {expanded && <CheckRunDetails check={check} state={detailsByCheckKey[row.key]} />}
                </div>
              )
            })}
          </div>
          {shouldConstrainCheckList && (
            <div
              role="separator"
              aria-orientation="horizontal"
              title={translate(
                'auto.components.right.sidebar.checks.panel.content.7f793b571d',
                'Drag to resize checks'
              )}
              className="group flex h-2 cursor-row-resize items-center border-b border-border"
              onMouseDown={handleResizeStart}
            >
              <div className="h-px w-full bg-transparent transition-colors group-hover:bg-ring/40" />
            </div>
          )}
          {checks.length >= 100 && (
            <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.cbcc4ab3db',
                'Showing first 100 checks'
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}

function CopyButton({
  text,
  title = 'Copy comment'
}: {
  text: string
  title?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after this row action unmounts; avoid
  // starting a reset timer that will outlive the component.
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void window.api.ui.writeClipboardText(text).then(() => {
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
    },
    [clearCopiedResetTimer, text]
  )

  return (
    <button
      ref={setCopyButtonRef}
      className="p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
      title={title}
      onClick={handleCopy}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

function ResolveButton({
  threadId,
  isResolved,
  onResolve
}: {
  threadId: string
  isResolved: boolean
  onResolve: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
}): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const loadingResetTimerRef = useRef<number | null>(null)

  const clearLoadingResetTimer = useCallback((): void => {
    if (loadingResetTimerRef.current !== null) {
      window.clearTimeout(loadingResetTimerRef.current)
      loadingResetTimerRef.current = null
    }
  }, [])

  const setResolveButtonRootRef = useCallback(
    (node: HTMLSpanElement | null) => {
      if (node === null) {
        clearLoadingResetTimer()
      }
    },
    [clearLoadingResetTimer]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      clearLoadingResetTimer()
      setLoading(true)
      void Promise.resolve(onResolve(threadId, !isResolved)).finally(() => setLoading(false))
    },
    [clearLoadingResetTimer, threadId, isResolved, onResolve]
  )

  return (
    <span ref={setResolveButtonRootRef} className="contents">
      {loading ? (
        <LoaderCircle className="size-3 animate-spin text-muted-foreground shrink-0" />
      ) : (
        <button
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent"
          onClick={handleClick}
        >
          {isResolved
            ? translate(
                'auto.components.right.sidebar.checks.panel.content.365254cc1b',
                'Unresolve'
              )
            : translate('auto.components.right.sidebar.checks.panel.content.0c96cd25e5', 'Resolve')}
        </button>
      )}
    </span>
  )
}

/** Format a line range string like "L12" or "L5-L12". */
function formatLineRange(comment: PRComment): string | null {
  if (!comment.line) {
    return null
  }
  if (comment.startLine && comment.startLine !== comment.line) {
    return `L${comment.startLine}-L${comment.line}`
  }
  return `L${comment.line}`
}

/** True for top-level PR conversation comments the viewer can edit or delete. */
export function isMutablePRConversationComment(comment: PRComment): boolean {
  if (comment.threadId || comment.path) {
    return false
  }
  if (comment.url && comment.url.includes('pullrequestreview')) {
    return false
  }
  return Number.isSafeInteger(comment.id) && comment.id > 0
}

function CommentMoreMenu({
  comment,
  onStartEdit,
  onDelete
}: {
  comment: PRComment
  onStartEdit?: () => void
  onDelete?: () => void | Promise<void>
}): React.JSX.Element | null {
  const hasGoToComment = Boolean(comment.url)
  const hasEdit = Boolean(onStartEdit)
  const hasDelete = Boolean(onDelete)
  if (!hasGoToComment && !hasEdit && !hasDelete) {
    return null
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.checks.panel.content.74c6885b8a',
            'More comment actions'
          )}
          title={translate('auto.components.right.sidebar.checks.panel.content.1abb17aac9', 'More')}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        {hasGoToComment && (
          <DropdownMenuItem onSelect={() => window.api.shell.openUrl(comment.url)}>
            <ExternalLink />
            {translate(
              'auto.components.right.sidebar.checks.panel.content.d3923d18fe',
              'Go to comment'
            )}
          </DropdownMenuItem>
        )}
        {hasGoToComment && (hasEdit || hasDelete) ? <DropdownMenuSeparator /> : null}
        {hasEdit ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onStartEdit?.()
            }}
          >
            <Pencil />
            {translate('auto.components.right.sidebar.checks.panel.content.03ca88f623', 'Edit')}
          </DropdownMenuItem>
        ) : null}
        {hasDelete ? (
          <DropdownMenuItem variant="destructive" onSelect={() => void onDelete?.()}>
            <Trash />
            {translate('auto.components.right.sidebar.checks.panel.content.6cc6eace26', 'Delete')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Build copy text that includes file location context for review comments. */
function buildCopyText(comment: PRComment): string {
  if (!comment.path) {
    return comment.body
  }
  const lineRange = formatLineRange(comment)
  const location = lineRange ? `${comment.path}:${lineRange}` : comment.path
  return `File: ${location}\n\n${comment.body}`
}

/** A single comment row — used for both root and reply comments. */
function CommentRow({
  comment,
  isReply,
  showResolve,
  showReply,
  replyDisabled,
  replyDisabledReason,
  onResolve,
  onReply,
  onEditComment,
  onDeleteComment
}: {
  comment: PRComment
  isReply: boolean
  showResolve: boolean
  showReply?: boolean
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onReply?: (comment: PRComment) => void
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const automated = isBotPRComment(comment)
  const canMutateComment = isMutablePRConversationComment(comment)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [submittingEdit, setSubmittingEdit] = useState(false)

  useEffect(() => {
    if (!editing) {
      setDraft(comment.body)
    }
  }, [comment.body, editing])

  const handleStartEdit = useCallback((): void => {
    setDraft(comment.body)
    setEditing(true)
  }, [comment.body])

  const handleCancelEdit = useCallback(
    (event: React.MouseEvent): void => {
      event.stopPropagation()
      setEditing(false)
      setDraft(comment.body)
    },
    [comment.body]
  )

  const handleSaveEdit = useCallback(
    async (event: React.MouseEvent): Promise<void> => {
      event.stopPropagation()
      const trimmedDraft = draft.trim()
      if (!onEditComment || !trimmedDraft || trimmedDraft === comment.body) {
        setEditing(false)
        return
      }
      setSubmittingEdit(true)
      try {
        const ok = await onEditComment(comment, trimmedDraft)
        if (ok) {
          setEditing(false)
        }
      } finally {
        setSubmittingEdit(false)
      }
    },
    [comment, draft, onEditComment]
  )

  const handleDelete = useCallback((): void => {
    void onDeleteComment?.(comment)
  }, [comment, onDeleteComment])

  const trimmedDraft = draft.trim()
  const canSaveEdit = !submittingEdit && trimmedDraft.length > 0 && trimmedDraft !== comment.body

  return (
    <div
      className={cn(
        'flex items-start gap-2 py-1.5 hover:bg-accent/40 transition-colors group/comment',
        isReply ? 'pl-7 pr-3' : 'px-3',
        comment.isResolved && PR_COMMENT_RESOLVED_CONTAINER_CLASS
      )}
    >
      <div className="flex-1 min-w-0">
        {/* Author line: avatar + name + file badge aligned on center */}
        <div className="flex items-center gap-1.5 min-w-0">
          {comment.authorAvatarUrl ? (
            <img
              src={comment.authorAvatarUrl}
              alt={comment.author}
              className={cn('rounded-full shrink-0', isReply ? 'size-3.5' : 'size-4')}
            />
          ) : (
            <div
              className={cn('rounded-full bg-muted shrink-0', isReply ? 'size-3.5' : 'size-4')}
            />
          )}
          <span
            className={cn(
              'text-[11px] font-semibold shrink-0',
              comment.isResolved ? PR_COMMENT_RESOLVED_AUTHOR_CLASS : PR_COMMENT_OPEN_AUTHOR_CLASS
            )}
          >
            {comment.author}
          </span>
          {automated && (
            <span className="shrink-0 rounded border border-border bg-accent/40 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              {translate('auto.components.right.sidebar.checks.panel.content.2ba0a32bdd', 'bot')}
            </span>
          )}
          {!isReply && comment.path && (
            <span className="text-[10px] font-mono text-muted-foreground/60 truncate min-w-0">
              {comment.path.split('/').pop()}
              {formatLineRange(comment) && `:${formatLineRange(comment)}`}
            </span>
          )}
          <div className="flex-1" />
          {!editing && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover/comment:opacity-100 transition-opacity">
              {showResolve && comment.threadId != null && onResolve && (
                <ResolveButton
                  threadId={comment.threadId}
                  isResolved={comment.isResolved ?? false}
                  onResolve={onResolve}
                />
              )}
              {showReply && onReply && (
                <button
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title={
                    replyDisabled
                      ? replyDisabledReason
                      : translate(
                          'auto.components.right.sidebar.checks.panel.content.c1f6fc006a',
                          'Reply'
                        )
                  }
                  disabled={replyDisabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    onReply(comment)
                  }}
                >
                  {translate(
                    'auto.components.right.sidebar.checks.panel.content.c1f6fc006a',
                    'Reply'
                  )}
                </button>
              )}
              <CopyButton text={buildCopyText(comment)} />
              <CommentMoreMenu
                comment={comment}
                onStartEdit={canMutateComment && onEditComment ? handleStartEdit : undefined}
                onDelete={canMutateComment && onDeleteComment ? handleDelete : undefined}
              />
            </div>
          )}
        </div>
        {editing ? (
          <div className={cn('mt-1 flex flex-col gap-1.5', isReply ? 'pl-5' : 'pl-[22px]')}>
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              className="min-h-[60px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[11px] leading-snug text-foreground"
            />
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={submittingEdit}
                onClick={handleCancelEdit}
              >
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.b062f55f29',
                  'Cancel'
                )}
              </Button>
              <Button
                type="button"
                size="xs"
                disabled={!canSaveEdit}
                onClick={(event) => void handleSaveEdit(event)}
              >
                {translate('auto.components.right.sidebar.checks.panel.content.f6a40263ff', 'Save')}
              </Button>
            </div>
          </div>
        ) : (
          <CommentMarkdown
            content={comment.body}
            className={cn(
              'mt-1 text-[11px] leading-snug text-muted-foreground',
              'break-words [&_p]:my-1 [&_pre]:max-h-none [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap [&_table]:w-full [&_table]:max-w-full',
              isReply ? 'pl-5' : 'pl-[22px]'
            )}
          />
        )}
      </div>
    </div>
  )
}

function PRCommentGroupView({
  group,
  replyingGroupId,
  replyDisabled,
  replyDisabledReason,
  onResolve,
  onStartReply,
  onCancelReply,
  onReply,
  onEditComment,
  onDeleteComment
}: {
  group: PRCommentGroup
  replyingGroupId: string | null
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onStartReply?: (groupId: string) => void
  onCancelReply?: () => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const groupId = getPRCommentGroupId(group)
  const root = getPRCommentGroupRoot(group)
  const replyComposer =
    replyingGroupId === groupId && onReply ? (
      <div className={cn('px-3 pb-2', group.kind === 'thread' && 'pl-6')}>
        <RightPanelCommentComposer
          placeholder={translate(
            'auto.components.right.sidebar.checks.panel.content.ba20d1a896',
            'Reply to {{value0}}',
            { value0: root.author }
          )}
          submitLabel="Reply"
          autoFocus
          disabled={replyDisabled}
          disabledReason={replyDisabledReason}
          onCancel={onCancelReply}
          onSubmit={(body) => onReply(root, body)}
        />
      </div>
    ) : null
  const startReply = onStartReply ? () => onStartReply(groupId) : undefined

  if (group.kind === 'standalone') {
    return (
      <div key={group.comment.id}>
        <CommentRow
          comment={group.comment}
          isReply={false}
          showResolve={false}
          showReply={Boolean(onReply)}
          replyDisabled={replyDisabled}
          replyDisabledReason={replyDisabledReason}
          onResolve={onResolve}
          onReply={startReply ? () => startReply() : undefined}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
        />
        {replyComposer}
      </div>
    )
  }
  return (
    <div key={group.threadId} className="py-0.5">
      <CommentRow
        comment={group.root}
        isReply={false}
        showResolve={true}
        showReply={Boolean(onReply)}
        replyDisabled={replyDisabled}
        replyDisabledReason={replyDisabledReason}
        onResolve={onResolve}
        onReply={startReply ? () => startReply() : undefined}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
      />
      {group.replies.length > 0 && (
        <div className="ml-3 border-l-2 border-border/50">
          {group.replies.map((reply) => (
            <CommentRow
              key={reply.id}
              comment={reply}
              isReply={true}
              showResolve={false}
              showReply={false}
              onResolve={onResolve}
              onEditComment={onEditComment}
              onDeleteComment={onDeleteComment}
            />
          ))}
        </div>
      )}
      {replyComposer}
    </div>
  )
}

function ResolvedCommentGroupAccordion({
  group,
  replyingGroupId,
  replyDisabled,
  replyDisabledReason,
  onResolve,
  onStartReply,
  onCancelReply,
  onReply,
  onEditComment,
  onDeleteComment
}: {
  group: PRCommentGroup
  replyingGroupId: string | null
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onStartReply?: (groupId: string) => void
  onCancelReply?: () => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const root = getPRCommentGroupRoot(group)
  const count = getPRCommentGroupCount(group)
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value={getPRCommentGroupId(group)} className="border-b-0">
        <AccordionTrigger className="px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/35">
          <span className="min-w-0 truncate">
            {translate('auto.components.right.sidebar.checks.panel.content.8987d5a3dd', 'Resolved')}{' '}
            {group.kind === 'thread'
              ? translate('auto.components.right.sidebar.checks.panel.content.95ad090b01', 'thread')
              : translate(
                  'auto.components.right.sidebar.checks.panel.content.90206b6353',
                  'comment'
                )}{' '}
            {translate('auto.components.right.sidebar.checks.panel.content.0fc6f743b3', 'by')}{' '}
            {root.author}
            {count > 1 ? ` (${count})` : ''}
          </span>
        </AccordionTrigger>
        <AccordionContent className="pb-1 pt-0">
          <PRCommentGroupView
            group={group}
            replyingGroupId={replyingGroupId}
            replyDisabled={replyDisabled}
            replyDisabledReason={replyDisabledReason}
            onResolve={onResolve}
            onStartReply={onStartReply}
            onCancelReply={onCancelReply}
            onReply={onReply}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function findVerticalScrollParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const canScroll = style.overflowY === 'auto' || style.overflowY === 'scroll'
    if (canScroll && parent.scrollHeight > parent.clientHeight) {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

function scrollElementBottomIntoView(element: HTMLElement): void {
  const scrollParent = findVerticalScrollParent(element)
  if (!scrollParent) {
    element.scrollIntoView({ block: 'end', behavior: 'smooth' })
    return
  }

  const padding = 8
  const parentRect = scrollParent.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const bottomOverflow = elementRect.bottom - parentRect.bottom + padding
  if (bottomOverflow > 0) {
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + bottomOverflow,
      behavior: 'smooth'
    })
    return
  }

  const topOverflow = elementRect.top - parentRect.top - padding
  if (topOverflow < 0) {
    scrollParent.scrollTo({
      top: Math.max(0, scrollParent.scrollTop + topOverflow),
      behavior: 'smooth'
    })
  }
}

/** Renders the PR comments section below checks. */
export function PRCommentsList({
  comments,
  commentsLoading,
  commentsDisabled,
  commentsDisabledReason,
  onAddComment,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment
}: {
  comments: PRComment[]
  commentsLoading: boolean
  commentsDisabled?: boolean
  commentsDisabledReason?: string
  onAddComment?: (body: string) => Promise<RightPanelCommentSubmitResult>
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const [replyingGroupId, setReplyingGroupId] = useState<string | null>(null)
  const [isAddingComment, setIsAddingComment] = useState(false)
  const addCommentSurfaceRef = useRef<HTMLDivElement>(null)
  const shouldScrollAddCommentRef = useRef(false)
  const commentCounts = React.useMemo(() => getPRCommentAudienceCounts(comments), [comments])
  const visibleComments = React.useMemo(
    () => filterPRCommentsByAudience(comments, commentFilter),
    [commentFilter, comments]
  )
  const groups = React.useMemo(() => groupPRComments(visibleComments), [visibleComments])
  useEffect(() => {
    if (!isAddingComment || !shouldScrollAddCommentRef.current) {
      return
    }
    shouldScrollAddCommentRef.current = false
    let secondFrame: number | null = null
    const scrollComposerIntoView = (): void => {
      const surface = addCommentSurfaceRef.current
      if (surface) {
        scrollElementBottomIntoView(surface)
      }
    }
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(scrollComposerIntoView)
    })
    // Why: the composer expands and focuses in separate layout passes; the
    // timeout catches the final height so the footer is visible in short panels.
    const settledTimer = window.setTimeout(scrollComposerIntoView, 120)
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame)
      }
      window.clearTimeout(settledTimer)
    }
  }, [isAddingComment])

  const startAddComment = useCallback(() => {
    shouldScrollAddCommentRef.current = true
    setIsAddingComment(true)
  }, [])

  const cancelAddComment = useCallback(() => {
    shouldScrollAddCommentRef.current = false
    setIsAddingComment(false)
  }, [])

  const renderAddCommentComposer = (empty: boolean): React.JSX.Element => (
    <div
      ref={addCommentSurfaceRef}
      className={cn(empty ? 'px-3 py-2' : 'border-t border-border px-3 py-2')}
    >
      <RightPanelCommentComposer
        placeholder={
          empty
            ? translate(
                'auto.components.right.sidebar.checks.panel.content.ea9fd5ed6a',
                'Start conversation...'
              )
            : translate(
                'auto.components.right.sidebar.checks.panel.content.3fff651d32',
                'Add a PR comment'
              )
        }
        submitLabel="Send"
        autoFocus
        disabled={commentsDisabled}
        disabledReason={commentsDisabledReason}
        onCancel={cancelAddComment}
        onSubmit={
          onAddComment ??
          (async () => ({
            ok: false,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.b37ebdc51c',
              'Commenting unavailable.'
            )
          }))
        }
      />
    </div>
  )

  return (
    <div className="border-t border-border">
      {/* Header */}
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-foreground">
            {translate('auto.components.right.sidebar.checks.panel.content.94557d68e2', 'Comments')}
          </span>
          {comments.length > 0 && (
            <span className="text-[10px] text-muted-foreground">{comments.length}</span>
          )}
          {onAddComment && !isAddingComment && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    comments.length === 0
                      ? translate(
                          'auto.components.right.sidebar.checks.panel.content.7440d09d2c',
                          'Start conversation'
                        )
                      : translate(
                          'auto.components.right.sidebar.checks.panel.content.2b2be92919',
                          'Add comment'
                        )
                  }
                  disabled={commentsDisabled}
                  title={commentsDisabled ? commentsDisabledReason : undefined}
                  className="-mr-1 ml-auto text-muted-foreground hover:text-foreground"
                  onClick={startAddComment}
                >
                  <Plus className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {commentsDisabled && commentsDisabledReason
                  ? commentsDisabledReason
                  : comments.length === 0
                    ? translate(
                        'auto.components.right.sidebar.checks.panel.content.7440d09d2c',
                        'Start conversation'
                      )
                    : translate(
                        'auto.components.right.sidebar.checks.panel.content.2b2be92919',
                        'Add comment'
                      )}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {comments.length > 0 && (
          <div className="mt-2 grid grid-cols-3 rounded-md border border-border bg-background p-0.5">
            {getPrCommentAudienceFilters().map((filter) => {
              const isActive = commentFilter === filter.value
              return (
                <button
                  key={filter.value}
                  type="button"
                  className={cn(
                    'flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors',
                    isActive && 'bg-muted text-foreground'
                  )}
                  aria-pressed={isActive}
                  onClick={() => setCommentFilter(filter.value)}
                >
                  <span>{filter.label}</span>
                  <span className="tabular-nums">{commentCounts[filter.value]}</span>
                </button>
              )
            })}
          </div>
        )}
        {comments.length >= 100 && (
          <div className="mt-1.5 text-[10px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.751f7c6e5c',
              'Showing first 100 comments per source'
            )}
          </div>
        )}
      </div>

      {/* List */}
      {commentsLoading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 && isAddingComment && onAddComment ? (
        renderAddCommentComposer(true)
      ) : comments.length === 0 ? (
        !onAddComment && (
          <div className="flex items-center justify-center py-5 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.755be805f6',
              'No comments'
            )}
          </div>
        )
      ) : visibleComments.length === 0 ? (
        <div className="flex items-center justify-center py-5 text-[11px] text-muted-foreground">
          {getPRCommentAudienceEmptyLabel(commentFilter)}
        </div>
      ) : (
        <div className="py-1">
          {groups.map((group) => {
            if (isResolvedPRCommentGroup(group)) {
              return (
                <ResolvedCommentGroupAccordion
                  key={getPRCommentGroupId(group)}
                  group={group}
                  replyingGroupId={replyingGroupId}
                  replyDisabled={commentsDisabled}
                  replyDisabledReason={commentsDisabledReason}
                  onResolve={onResolve}
                  onStartReply={setReplyingGroupId}
                  onCancelReply={() => setReplyingGroupId(null)}
                  onReply={onReply}
                  onEditComment={onEditComment}
                  onDeleteComment={onDeleteComment}
                />
              )
            }
            return (
              <PRCommentGroupView
                key={getPRCommentGroupId(group)}
                group={group}
                replyingGroupId={replyingGroupId}
                replyDisabled={commentsDisabled}
                replyDisabledReason={commentsDisabledReason}
                onResolve={onResolve}
                onStartReply={setReplyingGroupId}
                onCancelReply={() => setReplyingGroupId(null)}
                onReply={onReply}
                onEditComment={onEditComment}
                onDeleteComment={onDeleteComment}
              />
            )
          })}
        </div>
      )}
      {onAddComment && comments.length > 0 && isAddingComment && renderAddCommentComposer(false)}
    </div>
  )
}

export function prStateColor(state: PRInfo['state']): string {
  switch (state) {
    case 'merged':
      return 'bg-purple-500/15 text-purple-500 border-purple-500/20'
    case 'open':
      return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20'
    case 'closed':
      return 'bg-destructive/10 text-destructive border-destructive/20'
    case 'draft':
      return 'bg-muted text-muted-foreground/70 border-border'
  }
}
