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
  ChevronDown,
  ChevronRight,
  Sparkles,
  RefreshCw,
  Wrench,
  AlertTriangle,
  Maximize2,
  Plus
} from 'lucide-react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  getPRCommentAudienceEmptyLabel,
  isBotPRComment,
  PR_COMMENT_AUDIENCE_FILTERS,
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
import type { PRInfo, PRCheckDetail, PRCheckRunDetails, PRComment } from '../../../../shared/types'
import { useCheckDetailsResize } from './check-details-resize'
import {
  RightPanelCommentComposer,
  type RightPanelCommentSubmitResult
} from './right-panel-comment-composer'

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

export function ConflictingFilesSection({ pr }: { pr: PRInfo }): React.JSX.Element | null {
  const files = pr.conflictSummary?.files ?? []
  if (pr.mergeable !== 'CONFLICTING' || files.length === 0) {
    return null
  }

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="text-[11px] font-medium text-foreground">
        This branch has conflicts that must be resolved
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        It&apos;s {pr.conflictSummary!.commitsBehind} commit
        {pr.conflictSummary!.commitsBehind === 1 ? '' : 's'} behind (base commit:{' '}
        <span className="font-mono text-[10px]">{pr.conflictSummary!.baseCommit}</span>)
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Files className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="text-[11px] text-muted-foreground">Conflicting files</div>
      </div>
      <div className="mt-2 space-y-2">
        {files.map((filePath) => (
          <div key={filePath} className="rounded-md border border-border bg-accent/20 px-2.5 py-2">
            <div className="break-all font-mono text-[11px] leading-4 text-foreground">
              {filePath}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Fallback shown when GitHub reports merge conflicts but no file list is available yet. */
export function MergeConflictNotice({
  pr,
  isRefreshingConflictDetails
}: {
  pr: PRInfo
  isRefreshingConflictDetails: boolean
}): React.JSX.Element | null {
  if (pr.mergeable !== 'CONFLICTING' || (pr.conflictSummary?.files.length ?? 0) > 0) {
    return null
  }

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="text-[11px] font-medium text-foreground">
        This branch has conflicts that must be resolved
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {isRefreshingConflictDetails
          ? 'Refreshing conflict details…'
          : 'Conflict file details are unavailable'}
      </div>
    </div>
  )
}

export function PRTriageStrip({
  pr,
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
  pr: PRInfo
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
  const failingCount = checks.filter((check) => isFailedCheck(check)).length
  const pendingCount = checks.filter(
    (check) => check.conclusion === 'pending' || check.conclusion === null
  ).length

  if (pr.mergeable === 'CONFLICTING') {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-foreground">
              Conflicts block this PR
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              Resolve conflicts before checks and merge can complete.
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
            Resolve
          </Button>
        </div>
      </div>
    )
  }

  if (failingCount > 0) {
    return (
      <div className="border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <CircleX className="size-3.5 shrink-0 text-rose-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-foreground">
              {failingCount} failing check{failingCount === 1 ? '' : 's'}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              Inspect details or start an AI fix pass.
            </div>
          </div>
          <Button
            type="button"
            variant="default"
            size="xs"
            disabled={isFixingChecksWithAI || fixChecksDisabled}
            title={fixChecksDisabled ? fixChecksDisabledReason : undefined}
            onClick={onFixChecksWithAI}
          >
            {isFixingChecksWithAI ? (
              <RefreshCw className="size-3 animate-spin" />
            ) : (
              <Wrench className="size-3" />
            )}
            Fix
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
              {pendingCount} check{pendingCount === 1 ? '' : 's'} pending
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              Orca will refresh checks while this panel stays open.
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
            No blocking PR action
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            Checks and comments below show the current fetched context.
          </div>
        </div>
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

  return (
    <div className="mx-3 mb-2 min-w-0 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      {state?.loading ? (
        <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          Loading check details…
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              Status:{' '}
              {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
            </span>
            {startedAt && <span>Started {startedAt}</span>}
            {completedAt && <span>Completed {completedAt}</span>}
            {check.checkRunId && <span className="font-mono">check #{check.checkRunId}</span>}
            {check.workflowRunId && (
              <span className="font-mono">workflow #{check.workflowRunId}</span>
            )}
          </div>

          {state?.error && <div className="text-[12px] text-muted-foreground">{state.error}</div>}

          {hasOutput && (
            <div className="min-w-0 rounded-md border border-border/40 bg-background/70 px-2.5 py-2">
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
            <div className="min-w-0 rounded-md border border-border/40 bg-background/70">
              <div className="border-b border-border/40 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
                Annotations
              </div>
              <div className="flex max-h-40 flex-col overflow-y-auto scrollbar-sleek">
                {details!.annotations.map((annotation, index) => (
                  <div
                    key={`${annotation.path ?? 'annotation'}-${index}`}
                    className={cn(
                      'min-w-0 px-2.5 py-2 text-[12px]',
                      index > 0 && 'border-t border-border/30'
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                        {annotation.path ?? 'Annotation'}
                        {annotation.startLine ? `:${annotation.startLine}` : ''}
                      </span>
                      {annotation.annotationLevel && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {annotation.annotationLevel}
                        </span>
                      )}
                    </div>
                    {annotation.title && (
                      <div className="mt-1 text-[12px] font-medium text-foreground">
                        {annotation.title}
                      </div>
                    )}
                    <div className="mt-1 break-words text-[12px] text-foreground">
                      {annotation.message}
                    </div>
                    {annotation.rawDetails && (
                      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground scrollbar-sleek">
                        {annotation.rawDetails}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
              {details!.annotations.length >= 20 && (
                <div className="border-t border-border/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">
                  Showing first 20 annotations
                </div>
              )}
            </div>
          )}

          {hasJobs && (
            <div className="min-w-0 rounded-md border border-border/40 bg-background/70">
              <div className="border-b border-border/40 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
                {failedJobs.length > 0 ? 'Failed jobs' : 'Jobs'}
              </div>
              <div className="flex max-h-48 flex-col overflow-y-auto scrollbar-sleek">
                {jobs.map((job, index) => (
                  <div
                    key={`${job.name}-${index}`}
                    className={cn('min-w-0 px-2.5 py-2', index > 0 && 'border-t border-border/30')}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                        {job.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {job.conclusion ?? job.status ?? 'unknown'}
                      </span>
                    </div>
                    {job.steps.length > 0 && (
                      <div className="mt-1 grid gap-1">
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
                <div className="border-t border-border/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">
                  Showing first 100 jobs
                </div>
              )}
            </div>
          )}

          {!state?.error && !hasOutput && !hasAnnotations && !hasJobs && (
            <div className="text-[12px] text-muted-foreground">
              No inline details are available for this check.
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1">
            {!state?.loading && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    View full details
                    <Maximize2 className="size-3" />
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
            {openUrl && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={(event) => {
                  event.stopPropagation()
                  window.api.shell.openUrl(openUrl)
                }}
              >
                Open details
                <ExternalLink className="size-3" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CheckRunDetailsDialog({
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
            Status: {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
          </span>
          {startedAt && <span>Started {startedAt}</span>}
          {completedAt && <span>Completed {completedAt}</span>}
          {check.checkRunId && <span className="font-mono">check #{check.checkRunId}</span>}
          {check.workflowRunId && (
            <span className="font-mono">workflow #{check.workflowRunId}</span>
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-sleek">
        <div className="grid gap-4">
          {state?.error && <div className="text-sm text-muted-foreground">{state.error}</div>}

          {hasOutput && (
            <section className="rounded-md border border-border bg-background">
              <div className="border-b border-border px-3 py-2 text-sm font-medium">Output</div>
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
                Annotations
              </div>
              <div className="divide-y divide-border/50">
                {details!.annotations.map((annotation, index) => (
                  <div key={`${annotation.path ?? 'annotation'}-${index}`} className="px-3 py-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                        {annotation.path ?? 'Annotation'}
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
              <div className="border-b border-border px-3 py-2 text-sm font-medium">Jobs</div>
              <div className="divide-y divide-border/50">
                {jobs.map((job, index) => (
                  <div key={`${job.name}-${index}`} className="px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {job.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {job.conclusion ?? job.status ?? 'unknown'}
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
                  </div>
                ))}
              </div>
            </section>
          )}

          {!state?.error && !hasOutput && !hasAnnotations && !hasJobs && (
            <div className="text-sm text-muted-foreground">
              No details are available for this check.
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
            Open details
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      )}
    </DialogContent>
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
  const { detailsHeight, handleResizeStart } = useCheckDetailsResize(
    checksExpanded && checks.length > 0
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
            error: 'No inline details are available for this check.'
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
            error: 'No inline details are available for this check.'
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
              {passingCount} passing
            </span>
          )}
          {failingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleX className="size-3 text-rose-500" />
              {failingCount} failing
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <LoaderCircle className="size-3 text-amber-500" />
              {pendingCount} pending
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
          No checks configured
        </div>
      ) : !checksExpanded ? null : (
        <>
          <div
            className="overflow-y-auto py-1 scrollbar-sleek"
            style={{ maxHeight: detailsHeight }}
          >
            {rows.map((row) => {
              const check = row.check
              const conclusion = check.conclusion ?? 'pending'
              const Icon = CHECK_ICON[conclusion] ?? CircleDashed
              const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
              const expanded = expandedCheckKeys.has(row.key)
              return (
                <div key={row.key} className="min-w-0">
                  <div
                    className={cn(
                      'flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/40',
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
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {getCheckStatusLabel(check)}
                    </span>
                  </div>
                  {expanded && <CheckRunDetails check={check} state={detailsByCheckKey[row.key]} />}
                </div>
              )
            })}
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize checks"
            className="group flex h-2 cursor-row-resize items-center border-b border-border"
            onMouseDown={handleResizeStart}
          >
            <div className="h-px w-full bg-transparent transition-colors group-hover:bg-ring/40" />
          </div>
          {checks.length >= 100 && (
            <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              Showing first 100 checks
            </div>
          )}
        </>
      )}
    </>
  )
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
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
      title="Copy comment"
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
          {isResolved ? 'Unresolve' : 'Resolve'}
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
  onReply
}: {
  comment: PRComment
  isReply: boolean
  showResolve: boolean
  showReply?: boolean
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onReply?: (comment: PRComment) => void
}): React.JSX.Element {
  const automated = isBotPRComment(comment)
  return (
    <div
      className={cn(
        'flex items-start gap-2 py-1.5 hover:bg-accent/40 transition-colors cursor-pointer group/comment',
        isReply ? 'pl-7 pr-3' : 'px-3',
        comment.isResolved && PR_COMMENT_RESOLVED_CONTAINER_CLASS
      )}
      onClick={() => {
        if (comment.url) {
          window.api.shell.openUrl(comment.url)
        }
      }}
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
              bot
            </span>
          )}
          {!isReply && comment.path && (
            <span className="text-[10px] font-mono text-muted-foreground/60 truncate min-w-0">
              {comment.path.split('/').pop()}
              {formatLineRange(comment) && `:${formatLineRange(comment)}`}
            </span>
          )}
          <div className="flex-1" />
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
                title={replyDisabled ? replyDisabledReason : 'Reply'}
                disabled={replyDisabled}
                onClick={(event) => {
                  event.stopPropagation()
                  onReply(comment)
                }}
              >
                Reply
              </button>
            )}
            <CopyButton text={buildCopyText(comment)} />
          </div>
        </div>
        <CommentMarkdown
          content={comment.body}
          className={cn(
            'mt-1 text-[11px] leading-snug text-muted-foreground',
            'break-words [&_p]:my-1 [&_pre]:max-h-none [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap [&_table]:w-full [&_table]:max-w-full',
            isReply ? 'pl-5' : 'pl-[22px]'
          )}
        />
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
  onReply
}: {
  group: PRCommentGroup
  replyingGroupId: string | null
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onStartReply?: (groupId: string) => void
  onCancelReply?: () => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
}): React.JSX.Element {
  const groupId = getPRCommentGroupId(group)
  const root = getPRCommentGroupRoot(group)
  const replyComposer =
    replyingGroupId === groupId && onReply ? (
      <div className={cn('px-3 pb-2', group.kind === 'thread' && 'pl-6')}>
        <RightPanelCommentComposer
          placeholder={`Reply to ${root.author}`}
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
  onReply
}: {
  group: PRCommentGroup
  replyingGroupId: string | null
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onStartReply?: (groupId: string) => void
  onCancelReply?: () => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
}): React.JSX.Element {
  const root = getPRCommentGroupRoot(group)
  const count = getPRCommentGroupCount(group)
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value={getPRCommentGroupId(group)} className="border-b-0">
        <AccordionTrigger className="px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/35">
          <span className="min-w-0 truncate">
            Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by {root.author}
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
          />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

/** Renders the PR comments section below checks. */
export function PRCommentsList({
  comments,
  commentsLoading,
  commentsDisabled,
  commentsDisabledReason,
  onAddComment,
  onReply,
  onResolve
}: {
  comments: PRComment[]
  commentsLoading: boolean
  commentsDisabled?: boolean
  commentsDisabledReason?: string
  onAddComment?: (body: string) => Promise<RightPanelCommentSubmitResult>
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
}): React.JSX.Element {
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const [replyingGroupId, setReplyingGroupId] = useState<string | null>(null)
  const [isAddingComment, setIsAddingComment] = useState(false)
  const commentCounts = React.useMemo(() => getPRCommentAudienceCounts(comments), [comments])
  const visibleComments = React.useMemo(
    () => filterPRCommentsByAudience(comments, commentFilter),
    [commentFilter, comments]
  )
  const groups = React.useMemo(() => groupPRComments(visibleComments), [visibleComments])

  return (
    <div className="border-t border-border">
      {/* Header */}
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-foreground">Comments</span>
          {comments.length > 0 && (
            <span className="text-[10px] text-muted-foreground">{comments.length}</span>
          )}
        </div>
        {comments.length > 0 && (
          <div className="mt-2 grid grid-cols-3 rounded-md border border-border bg-background p-0.5">
            {PR_COMMENT_AUDIENCE_FILTERS.map((filter) => {
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
            Showing first 100 comments per source
          </div>
        )}
      </div>

      {/* List */}
      {commentsLoading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-[11px] text-muted-foreground">
          No comments
        </div>
      ) : visibleComments.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-[11px] text-muted-foreground">
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
              />
            )
          })}
        </div>
      )}
      {onAddComment && (
        <div className="border-t border-border px-3 py-2">
          {isAddingComment ? (
            <RightPanelCommentComposer
              placeholder="Add a PR comment"
              submitLabel="Comment"
              autoFocus
              disabled={commentsDisabled}
              disabledReason={commentsDisabledReason}
              onCancel={() => setIsAddingComment(false)}
              onSubmit={onAddComment}
            />
          ) : (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={commentsDisabled}
                title={commentsDisabled ? commentsDisabledReason : undefined}
                onClick={() => setIsAddingComment(true)}
              >
                <Plus className="size-3" />
                Add Comment
              </Button>
            </div>
          )}
        </div>
      )}
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
