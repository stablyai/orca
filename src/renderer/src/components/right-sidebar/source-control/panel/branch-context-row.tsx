import React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitBranchLineTotal } from '../../../../../../shared/git/status/git-status-types'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HeadIdentity } from './head-identity'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'
import { SourceControlHeaderIconButton } from './header-icon-button'
import { SourceControlBranchLineTotalChip } from './branch-line-total-chip'
import {
  buildSourceControlCompareBaseStats,
  formatSourceControlRefLabel,
  resolveSourceControlDisplayedBaseRef,
  type SourceControlBranchContextStat
} from './branch-context-stats'

function ContextStat({ stat }: { stat: SourceControlBranchContextStat }): React.JSX.Element {
  // Make stats focusable so screen readers announce their base and keyboard users can open the tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 rounded-sm tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring"
          tabIndex={0}
          aria-label={stat.title}
          data-testid={`source-control-${stat.key}`}
        >
          {stat.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {stat.title}
      </TooltipContent>
    </Tooltip>
  )
}

function resolveHeadFlowLabel(
  display: WorktreeGitIdentityDisplay | null | undefined
): string | null {
  if (display?.kind === 'branch') {
    return display.branchName
  }
  if (display?.kind === 'detached') {
    return display.sourceControlLabel
  }
  return null
}

/**
 * Two rows: HEAD with the review action, then a quiet status line (commits vs base, line totals).
 * The base ref name is not shown; Change Base Ref lives in the overflow and scope menus, and the
 * group's accessible name still says which base the counts measure.
 */
export function SourceControlBranchContextRow({
  summary,
  compareBaseRef,
  headDisplay = null,
  headControl,
  branchLineTotal,
  reviewControl,
  operationRow = null,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  headDisplay?: WorktreeGitIdentityDisplay | null
  headControl?: React.ReactNode
  branchLineTotal?: GitBranchLineTotal | null
  reviewControl?: React.ReactNode
  /** A paused rebase, merge, cherry-pick or revert; it replaces the HEAD row and status line. */
  operationRow?: React.ReactNode
  onRetry: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const displayedBaseRef = resolveSourceControlDisplayedBaseRef(summary, compareBaseRef)
  const baseLabel = displayedBaseRef ? formatSourceControlRefLabel(displayedBaseRef) : null
  const headLabel = resolveHeadFlowLabel(headDisplay)
  const flowLabel =
    headLabel != null && baseLabel != null
      ? t('auto.components.right.sidebar.SourceControl.b8c2e1a904', '{{value0}} → {{value1}}', {
          value0: headLabel,
          value1: baseLabel
        })
      : undefined
  const loading = baseLabel != null && (!summary || summary.status === 'loading')
  const failed = baseLabel != null && summary != null && !loading && summary.status !== 'ready'
  const ready = baseLabel != null && summary?.status === 'ready'

  const statusLine = loading ? (
    // aria-busy stays on the compare row, never on the whole header.
    <div className="flex h-5 min-w-0 items-center" aria-busy="true">
      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      <span className="sr-only">
        {t(
          'auto.components.right.sidebar.SourceControl.compareLoadingAgainst',
          'Comparing against {{base}}',
          { base: baseLabel }
        )}
      </span>
    </div>
  ) : failed ? (
    <div className="flex min-h-5 min-w-0 items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate" title={summary?.errorMessage ?? undefined}>
        {summary?.errorMessage ??
          t('auto.components.right.sidebar.SourceControl.715d229c86', 'Branch compare unavailable')}
      </span>
      <SourceControlHeaderIconButton
        icon={RefreshCw}
        label={t('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
        onClick={onRetry}
      />
    </div>
  ) : ready ? (
    <ReadyStatusLine
      stats={buildSourceControlCompareBaseStats(summary, displayedBaseRef ?? '', t)}
      branchLineTotal={branchLineTotal}
    />
  ) : null

  // A paused operation owns the header: its row says what HEAD is doing, so the HEAD pill,
  // review action and compare stats wait until it ends.
  if (operationRow) {
    return (
      <div
        className="flex min-w-0 flex-col text-[11px] text-muted-foreground"
        data-testid="source-control-branch-context"
      >
        {operationRow}
      </div>
    )
  }
  const headRowShown = headDisplay != null || reviewControl != null
  if (!headRowShown && !statusLine) {
    return null
  }
  return (
    <div
      className="flex min-w-0 flex-col text-[11px] text-muted-foreground"
      role={flowLabel != null ? 'group' : undefined}
      aria-label={flowLabel}
      data-testid="source-control-branch-context"
    >
      {headRowShown ? (
        // gap-2 keeps the ellipsized branch name from reading as part of the review action.
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center">
            {headDisplay ? (headControl ?? <HeadIdentity display={headDisplay} />) : null}
          </span>
          {reviewControl}
        </div>
      ) : null}
      {statusLine}
    </div>
  )
}

function ReadyStatusLine({
  stats,
  branchLineTotal
}: {
  stats: SourceControlBranchContextStat[]
  branchLineTotal: GitBranchLineTotal | null | undefined
}): React.JSX.Element | null {
  const hasLineTotal = (branchLineTotal?.added ?? 0) > 0 || (branchLineTotal?.removed ?? 0) > 0
  // Up to date with nothing changed: hide the line rather than say so.
  if (stats.length === 0 && !hasLineTotal) {
    return null
  }
  return (
    <div
      className="flex h-5 min-w-0 items-center gap-1.5"
      data-testid="source-control-branch-status-line"
    >
      {stats.map((stat) => (
        <ContextStat key={stat.key} stat={stat} />
      ))}
      <span className="min-w-0 flex-1" aria-hidden="true" />
      <SourceControlBranchLineTotalChip branchLineTotal={branchLineTotal} />
    </div>
  )
}
