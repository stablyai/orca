import React from 'react'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { GitBranchCompareSummary, GitUpstreamStatus } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { SourceControlHeaderIconButton } from './source-control-header-icon-button'
import {
  buildSourceControlBranchContextStats,
  formatSourceControlRefLabel,
  resolveSourceControlDisplayedBaseRef
} from './source-control-branch-context-stats'

function BaseRefButton({
  baseRef,
  displayLabel,
  onClick,
  title
}: {
  baseRef: string
  displayLabel: string
  onClick: () => void
  title: string
}): React.JSX.Element {
  const accessibleName = translate(
    'auto.components.right.sidebar.SourceControl.c7d4e2f801',
    'Change base ref: {{value0}}',
    { value0: displayLabel }
  )
  return (
    <button
      type="button"
      className="min-w-0 max-w-full truncate rounded-sm border-0 bg-transparent p-0 text-left font-mono text-[10.5px] font-medium text-foreground/90 underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
      onClick={onClick}
      title={`${title} (${baseRef})`}
      aria-label={accessibleName}
    >
      {displayLabel}
    </button>
  )
}

function ContextStat({
  stat
}: {
  stat: ReturnType<typeof buildSourceControlBranchContextStats>[number]
}): React.JSX.Element {
  const className = cn(
    'shrink-0 tabular-nums text-muted-foreground',
    stat.tone === 'muted' && 'text-muted-foreground/70',
    stat.tone === 'ahead' && 'text-[color:var(--git-decoration-added)]',
    stat.tone === 'behind' && 'text-[color:var(--git-decoration-deleted)]'
  )

  if (!stat.title) {
    return <span className={className}>{stat.label}</span>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{stat.label}</span>
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
  if (!url) {
    return null
  }
  return (
    <SourceControlHeaderIconButton
      icon={ExternalLink}
      label={translate(
        'auto.components.right.sidebar.SourceControl.4b4a7de138',
        'Open review page in browser'
      )}
      onClick={() => {
        void window.api.shell.openUrl(url)
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

function HeadIdentity({ display }: { display: WorktreeGitIdentityDisplay }): React.JSX.Element {
  if (display.kind === 'detached') {
    return (
      <DetachedHeadBadge
        display={display}
        side="bottom"
        // Why: tooltip carries the full detached explanation; keep it keyboard-reachable.
        tabIndex={0}
        className="min-w-0 max-w-full shrink"
      />
    )
  }

  const branchAriaLabel = translate(
    'auto.components.right.sidebar.SourceControl.a4e93c21d7',
    'Current branch: {{value0}}',
    { value0: display.branchName }
  )

  // Why: focusable + tooltip so truncated long branch names stay discoverable.
  // Native title omitted — Radix Tooltip already surfaces the full name on hover.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="min-w-0 max-w-full truncate rounded-sm font-mono text-[10.5px] font-medium text-foreground/90 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          tabIndex={0}
          aria-label={branchAriaLabel}
          data-testid="source-control-head-identity"
        >
          {display.branchName}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-all font-mono">
        {display.branchName}
      </TooltipContent>
    </Tooltip>
  )
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

function BaseLine({
  baseRef,
  baseLabel,
  onChangeBaseRef,
  changeBaseTitle,
  showArrow,
  leading,
  trailing
}: {
  baseRef: string
  baseLabel: string
  onChangeBaseRef: () => void
  changeBaseTitle: string
  showArrow: boolean
  leading?: React.ReactNode
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {leading}
      {showArrow ? (
        <span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
          →
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground">
          {translate('auto.components.right.sidebar.SourceControl.e8a1c4b203', 'vs')}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <BaseRefButton
          baseRef={baseRef}
          displayLabel={baseLabel}
          onClick={onChangeBaseRef}
          title={changeBaseTitle}
        />
      </span>
      {trailing}
    </div>
  )
}

// Why: stacked head / → base (option B) so long branch names fit narrow sidebars
// without truncating both sides of a single-line head→base pair.
function StackedCompareFlow({
  headDisplay,
  baseRef,
  baseLabel,
  onChangeBaseRef,
  changeBaseTitle,
  leading,
  trailing
}: {
  headDisplay: WorktreeGitIdentityDisplay | null
  baseRef: string
  baseLabel: string
  onChangeBaseRef: () => void
  changeBaseTitle: string
  leading?: React.ReactNode
  trailing?: React.ReactNode
}): React.JSX.Element {
  if (!headDisplay) {
    return (
      <BaseLine
        baseRef={baseRef}
        baseLabel={baseLabel}
        onChangeBaseRef={onChangeBaseRef}
        changeBaseTitle={changeBaseTitle}
        showArrow={false}
        leading={leading}
        trailing={trailing}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="min-w-0">
        <HeadIdentity display={headDisplay} />
      </div>
      {/* Why: spinner/actions sit on the base line — they describe compare state, not HEAD. */}
      <BaseLine
        baseRef={baseRef}
        baseLabel={baseLabel}
        onChangeBaseRef={onChangeBaseRef}
        changeBaseTitle={changeBaseTitle}
        showArrow
        leading={leading}
        trailing={trailing}
      />
    </div>
  )
}

export function SourceControlBranchContextRow({
  summary,
  compareBaseRef,
  headDisplay = null,
  upstreamStatus,
  manualReviewUrl,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  headDisplay?: WorktreeGitIdentityDisplay | null
  upstreamStatus?: GitUpstreamStatus
  manualReviewUrl?: string | null
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  const displayedBaseRef = resolveSourceControlDisplayedBaseRef(summary, compareBaseRef)

  // Why: no base → still show HEAD identity so branch/detached never vanish when
  // compare isn't configured (replaces the separate identity row from #10215).
  if (!displayedBaseRef) {
    if (!headDisplay) {
      return null
    }
    return (
      <div className="min-w-0 text-[11px] text-muted-foreground">
        <HeadIdentity display={headDisplay} />
      </div>
    )
  }

  const baseLabel = formatSourceControlRefLabel(displayedBaseRef)
  const changeBaseTitle = translate(
    'auto.components.right.sidebar.SourceControl.493f963029',
    'Change base ref'
  )
  const headLabel = resolveHeadFlowLabel(headDisplay)
  const flowLabel =
    headLabel != null
      ? translate(
          'auto.components.right.sidebar.SourceControl.b8c2e1a904',
          '{{value0}} → {{value1}}',
          { value0: headLabel, value1: baseLabel }
        )
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
          baseRef={displayedBaseRef}
          baseLabel={baseLabel}
          onChangeBaseRef={onChangeBaseRef}
          changeBaseTitle={changeBaseTitle}
          leading={<Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
          trailing={<ManualReviewLinkButton url={manualReviewUrl} />}
        />
        <span className="sr-only">
          {translate('auto.components.right.sidebar.SourceControl.11b5dd8e41', 'Comparing against')}
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
          baseRef={displayedBaseRef}
          baseLabel={baseLabel}
          onChangeBaseRef={onChangeBaseRef}
          changeBaseTitle={changeBaseTitle}
          trailing={
            <>
              <ManualReviewLinkButton url={manualReviewUrl} />
              <SourceControlHeaderIconButton
                icon={RefreshCw}
                label={translate('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
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
            translate(
              'auto.components.right.sidebar.SourceControl.715d229c86',
              'Branch compare unavailable'
            )}
        </span>
      </CompareFlowGroup>
    )
  }

  const stats = buildSourceControlBranchContextStats({
    summary,
    baseRef: displayedBaseRef,
    upstreamStatus
  })

  const trailing = (
    <>
      {stats.length > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {stats.map((stat) => (
            <ContextStat key={stat.key} stat={stat} />
          ))}
        </span>
      ) : null}
      <ManualReviewLinkButton url={manualReviewUrl} />
    </>
  )

  return (
    <CompareFlowGroup flowLabel={flowLabel} className="min-w-0 text-[11px] text-muted-foreground">
      <StackedCompareFlow
        headDisplay={headDisplay}
        baseRef={displayedBaseRef}
        baseLabel={baseLabel}
        onChangeBaseRef={onChangeBaseRef}
        changeBaseTitle={changeBaseTitle}
        trailing={trailing}
      />
    </CompareFlowGroup>
  )
}
