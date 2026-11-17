import React from 'react'
import { ArrowUp, RefreshCw, Settings2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'

export type BranchCompareStatusHeadSnapshot = {
  baseRef: string
  statusHead: string | null
  worktreeId: string
}

export type BranchCompareRemoteStatusSnapshot = {
  ahead: number | null
  baseRef: string
  behind: number | null
  hasUpstream: boolean | null
  upstreamName: string | null
  worktreeId: string
}

export function shouldRefreshBranchCompareForStatusHead(
  previous: BranchCompareStatusHeadSnapshot | null,
  current: BranchCompareStatusHeadSnapshot
): boolean {
  // A first status load is not a HEAD move; the visible-entry compare already read HEAD.
  return (
    current.statusHead !== null &&
    previous !== null &&
    previous.statusHead !== null &&
    previous.worktreeId === current.worktreeId &&
    previous.baseRef === current.baseRef &&
    previous.statusHead !== current.statusHead
  )
}

export function shouldRefreshBranchCompareForRemoteStatus(
  previous: BranchCompareRemoteStatusSnapshot | null,
  current: BranchCompareRemoteStatusSnapshot
): boolean {
  // A first upstream load is not a push.
  return (
    previous !== null &&
    previous.hasUpstream !== null &&
    previous.worktreeId === current.worktreeId &&
    previous.baseRef === current.baseRef &&
    (previous.hasUpstream !== current.hasUpstream ||
      previous.upstreamName !== current.upstreamName ||
      previous.ahead !== current.ahead ||
      previous.behind !== current.behind)
  )
}

export function shouldShowCompareSummary(summary: GitBranchCompareSummary | null): boolean {
  if (!summary || summary.status === 'loading') {
    return true
  }
  if (summary.status !== 'ready') {
    return true
  }
  return typeof summary.commitsAhead === 'number' && summary.commitsAhead > 0
}

export function CompareSummary({
  summary,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!summary || summary.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5 animate-spin" />
        <span>
          {t(
            'auto.components.right.sidebar.SourceControl.comparingAgainstRef',
            'Comparing against {{ref}}',
            {
              ref: summary?.baseRef ?? '…'
            }
          )}
        </span>
      </div>
    )
  }

  if (summary.status !== 'ready') {
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {summary.errorMessage ??
            t(
              'auto.components.right.sidebar.SourceControl.715d229c86',
              'Branch compare unavailable'
            )}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <CompareSummaryToolbarButton
            icon={Settings2}
            label={t('auto.components.right.sidebar.SourceControl.493f963029', 'Change base ref')}
            onClick={onChangeBaseRef}
          />
          <CompareSummaryToolbarButton
            icon={RefreshCw}
            label={t('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
            onClick={onRetry}
          />
        </div>
      </div>
    )
  }

  const commitsAhead = summary.commitsAhead
  const showCommitsAhead = typeof commitsAhead === 'number' && commitsAhead > 0
  const commitsAheadTitle = !showCommitsAhead
    ? undefined
    : t(
        'auto.components.right.sidebar.source.control.compare.summary.commitsAhead',
        '{{count}} commits ahead of {{ref}}',
        {
          count: commitsAhead,
          ref: summary.baseRef,
          defaultValue_one: '{{count}} commit ahead of {{ref}}'
        }
      )

  if (!showCommitsAhead) {
    return null
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1" title={commitsAheadTitle}>
        <ArrowUp className="size-3" />
        <span>
          {t('auto.components.right.sidebar.SourceControl.commitsAheadShort', '{{count}} ahead', {
            count: commitsAhead,
            defaultValue_one: '{{count}} ahead'
          })}
        </span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <CompareSummaryToolbarButton
          icon={Settings2}
          label={t('auto.components.right.sidebar.SourceControl.493f963029', 'Change base ref')}
          onClick={onChangeBaseRef}
        />
        <CompareSummaryToolbarButton
          icon={RefreshCw}
          label={t(
            'auto.components.right.sidebar.SourceControl.ed34038d0d',
            'Refresh branch compare'
          )}
          onClick={onRetry}
        />
      </div>
    </div>
  )
}

export function CompareSummaryToolbarButton({
  icon: Icon,
  label,
  onClick
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={onClick}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function CompareUnavailable({
  summary,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const changeBaseRefAllowed =
    summary.status === 'invalid-base' ||
    summary.status === 'no-merge-base' ||
    summary.status === 'error'

  return (
    <div className="m-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-xs">
      <div className="font-medium text-foreground">
        {summary.status === 'error'
          ? t('auto.components.right.sidebar.SourceControl.97d8b03cdf', 'Branch compare failed')
          : t(
              'auto.components.right.sidebar.SourceControl.715d229c86',
              'Branch compare unavailable'
            )}
      </div>
      <div className="mt-1 text-muted-foreground">
        {summary.errorMessage ??
          t(
            'auto.components.right.sidebar.SourceControl.b6922abb13',
            'Unable to load branch compare.'
          )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {changeBaseRefAllowed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onChangeBaseRef}
          >
            <Settings2 className="size-3.5" />
            {t('auto.components.right.sidebar.SourceControl.476b77745b', 'Change Base Ref')}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          {t('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
        </Button>
      </div>
    </div>
  )
}
