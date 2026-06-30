import React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { GitBranchCompareSummary, GitUpstreamStatus } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SourceControlHeaderIconButton } from './source-control-header-icon-button'
import {
  buildSourceControlBranchContextStats,
  resolveSourceControlDisplayedBaseRef,
  shouldShowSourceControlBranchContextRow
} from './source-control-branch-context-stats'

export { shouldShowSourceControlBranchContextRow } from './source-control-branch-context-stats'

function BaseRefButton({
  baseRef,
  onClick,
  title
}: {
  baseRef: string
  onClick: () => void
  title: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="min-w-0 max-w-full truncate rounded-sm border-0 bg-transparent p-0 text-left font-mono text-[10.5px] font-medium text-foreground/90 underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
      onClick={onClick}
      title={`${title} (${baseRef})`}
    >
      {baseRef}
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
    stat.tone === 'muted' && 'text-muted-foreground/70'
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

export function SourceControlBranchContextRow({
  summary,
  compareBaseRef,
  upstreamStatus,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  upstreamStatus?: GitUpstreamStatus
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  const displayedBaseRef = resolveSourceControlDisplayedBaseRef(summary, compareBaseRef)
  if (!shouldShowSourceControlBranchContextRow(summary, compareBaseRef) || !displayedBaseRef) {
    return null
  }

  const changeBaseTitle = translate(
    'auto.components.right.sidebar.SourceControl.493f963029',
    'Change base ref'
  )

  if (!summary || summary.status === 'loading') {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span className="shrink-0 text-muted-foreground">
          {translate('auto.components.right.sidebar.SourceControl.e8a1c4b203', 'vs')}
        </span>
        <span className="min-w-0 flex-1">
          <BaseRefButton
            baseRef={displayedBaseRef}
            onClick={onChangeBaseRef}
            title={changeBaseTitle}
          />
        </span>
      </div>
    )
  }

  if (summary.status !== 'ready') {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1">
          <BaseRefButton
            baseRef={displayedBaseRef}
            onClick={onChangeBaseRef}
            title={changeBaseTitle}
          />
        </span>
        <span className="min-w-0 flex-1 truncate" title={summary.errorMessage ?? undefined}>
          {summary.errorMessage ??
            translate(
              'auto.components.right.sidebar.SourceControl.715d229c86',
              'Branch compare unavailable'
            )}
        </span>
        <SourceControlHeaderIconButton
          icon={RefreshCw}
          label={translate('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
          onClick={onRetry}
        />
      </div>
    )
  }

  const stats = buildSourceControlBranchContextStats({
    summary,
    baseRef: displayedBaseRef,
    upstreamStatus
  })

  return (
    <div className="flex min-w-0 items-center justify-between gap-1.5 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="shrink-0">
          {translate('auto.components.right.sidebar.SourceControl.e8a1c4b203', 'vs')}
        </span>
        <span className="min-w-0 flex-1">
          <BaseRefButton
            baseRef={displayedBaseRef}
            onClick={onChangeBaseRef}
            title={changeBaseTitle}
          />
        </span>
      </div>
      {stats.length > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {stats.map((stat) => (
            <ContextStat key={stat.key} stat={stat} />
          ))}
        </span>
      ) : null}
    </div>
  )
}
