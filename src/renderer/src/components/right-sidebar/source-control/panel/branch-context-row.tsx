import React from 'react'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitBranchLineTotal } from '../../../../../../shared/git/status/git-status-types'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HeadIdentity } from './head-identity'
import { StackedCompareFlow } from './branch-compare-flow'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import { SourceControlHeaderIconButton } from './header-icon-button'
import { SourceControlBranchLineTotalChip } from './branch-line-total-chip'
import {
  buildSourceControlCompareBaseStats,
  formatSourceControlRefLabel,
  resolveSourceControlDisplayedBaseRef,
  type SourceControlBranchContextStat
} from './branch-context-stats'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

function ContextStat({ stat }: { stat: SourceControlBranchContextStat }): React.JSX.Element {
  // Make stats focusable so screen readers announce their base and keyboard users can open the tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 rounded-sm tabular-nums text-muted-foreground/70 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          tabIndex={0}
          aria-label={stat.title}
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

function ManualReviewLinkButton({
  url
}: {
  url: string | null | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!url) {
    return null
  }
  return (
    <SourceControlHeaderIconButton
      icon={ExternalLink}
      label={t(
        'auto.components.right.sidebar.SourceControl.4b4a7de138',
        'Open review page in browser'
      )}
      onClick={() => {
        openAppHttpLink(url)
      }}
    />
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

function CompareFlowGroup({
  flowLabel,
  busy,
  className,
  children
}: {
  flowLabel: string | undefined
  busy?: boolean
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={className}
      role={flowLabel != null ? 'group' : undefined}
      aria-label={flowLabel}
      aria-busy={busy ? true : undefined}
    >
      {children}
    </div>
  )
}

export function SourceControlBranchContextRow({
  summary,
  compareBaseRef,
  headDisplay = null,
  headControl,
  manualReviewUrl,
  branchLineTotal,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  headDisplay?: WorktreeGitIdentityDisplay | null
  headControl?: React.ReactNode
  manualReviewUrl?: string | null
  branchLineTotal?: GitBranchLineTotal | null
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const displayedBaseRef = resolveSourceControlDisplayedBaseRef(summary, compareBaseRef)

  // Retain head/detached identity without a compare base, replacing the separate identity row (#10215).
  if (!displayedBaseRef) {
    if (!headDisplay) {
      return null
    }
    return (
      <div className="min-w-0 text-[11px] text-muted-foreground">
        {headControl ?? <HeadIdentity display={headDisplay} />}
      </div>
    )
  }

  const baseLabel = formatSourceControlRefLabel(displayedBaseRef)
  const changeBaseTitle = t(
    'auto.components.right.sidebar.SourceControl.493f963029',
    'Change base ref'
  )
  const headLabel = resolveHeadFlowLabel(headDisplay)
  const flowLabel =
    headLabel != null
      ? t('auto.components.right.sidebar.SourceControl.b8c2e1a904', '{{value0}} → {{value1}}', {
          value0: headLabel,
          value1: baseLabel
        })
      : undefined

  if (!summary || summary.status === 'loading') {
    return (
      <CompareFlowGroup
        flowLabel={flowLabel}
        busy
        className="min-w-0 text-[11px] text-muted-foreground"
      >
        <StackedCompareFlow
          headDisplay={headDisplay}
          headControl={headControl}
          baseRef={displayedBaseRef}
          baseLabel={baseLabel}
          onChangeBaseRef={onChangeBaseRef}
          changeBaseTitle={changeBaseTitle}
          leading={<Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
          trailing={<ManualReviewLinkButton url={manualReviewUrl} />}
        />
        <span className="sr-only">
          {t('auto.components.right.sidebar.SourceControl.11b5dd8e41', 'Comparing against')}
        </span>
      </CompareFlowGroup>
    )
  }

  if (summary.status !== 'ready') {
    return (
      <CompareFlowGroup
        flowLabel={flowLabel}
        className="flex min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground"
      >
        <StackedCompareFlow
          headDisplay={headDisplay}
          headControl={headControl}
          baseRef={displayedBaseRef}
          baseLabel={baseLabel}
          onChangeBaseRef={onChangeBaseRef}
          changeBaseTitle={changeBaseTitle}
          trailing={
            <>
              <ManualReviewLinkButton url={manualReviewUrl} />
              <SourceControlHeaderIconButton
                icon={RefreshCw}
                label={t('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
                onClick={onRetry}
              />
            </>
          }
        />
        {/* Why: pl-4 under the base line so the error reads as compare state, not HEAD. */}
        <span
          className={cn('min-w-0 truncate', headDisplay != null && 'pl-4')}
          title={summary.errorMessage ?? undefined}
        >
          {summary.errorMessage ??
            t(
              'auto.components.right.sidebar.SourceControl.715d229c86',
              'Branch compare unavailable'
            )}
        </span>
      </CompareFlowGroup>
    )
  }

  const compareStatNodes = buildSourceControlCompareBaseStats(summary, displayedBaseRef, t).map(
    (stat) => <ContextStat key={stat.key} stat={stat} />
  )

  return (
    <CompareFlowGroup flowLabel={flowLabel} className="min-w-0 text-[11px] text-muted-foreground">
      <StackedCompareFlow
        headDisplay={headDisplay}
        headControl={headControl}
        baseRef={displayedBaseRef}
        baseLabel={baseLabel}
        onChangeBaseRef={onChangeBaseRef}
        changeBaseTitle={changeBaseTitle}
        trailing={
          <>
            {compareStatNodes}
            <ManualReviewLinkButton url={manualReviewUrl} />
          </>
        }
        headTrailing={<SourceControlBranchLineTotalChip branchLineTotal={branchLineTotal} />}
      />
    </CompareFlowGroup>
  )
}
