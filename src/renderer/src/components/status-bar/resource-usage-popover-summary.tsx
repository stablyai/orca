import React from 'react'
import { AlertTriangle, MemoryStick, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { DaemonActionsApi } from '../shared/useDaemonActions'
import type {
  getResourceCommitMetricCopy,
  getResourceMemoryMetricCopy
} from './resource-memory-metric-copy'
import { formatCpu, formatMemory } from './resource-usage-metrics'

export function renderResourceUsagePopoverHeader(
  {
    daemonActions,
    onRefresh
  }: {
    daemonActions: DaemonActionsApi
    onRefresh?: () => void
  },
  t: Translate = translate
): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
        <MemoryStick className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {t('auto.components.status.bar.StatusBar.d1e1a7a6bf', 'Resource Manager')}
        </span>
      </div>

      <div className="flex items-center gap-0.5">
        {onRefresh && (
          <Button variant="ghost" size="xs" onClick={onRefresh}>
            {t('resourceManager.refresh', 'Refresh')}
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => daemonActions.setPending('restart')}
              disabled={daemonActions.isBusy}
              aria-label={t('resourceManager.restartLocal', 'Restart local daemon')}
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <RotateCw className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {t('resourceManager.restartLocal', 'Restart local daemon')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => daemonActions.setPending('killAll')}
              disabled={daemonActions.isBusy}
              aria-label={t('resourceManager.killAllLocal', 'Kill all local sessions')}
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
            >
              <Trash2 className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {t('resourceManager.killAllLocal', 'Kill all local sessions')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function renderDaemonUnreachableBanner(
  {
    daemonActions
  }: {
    daemonActions: DaemonActionsApi
  },
  t: Translate = translate
): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 border-b border-border bg-yellow-500/10 px-3 py-2 text-[11px] text-foreground">
      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-yellow-500" />
      <div className="flex-1">
        <div className="font-medium">
          {t(
            'auto.components.status.bar.ResourceUsageStatusSegment.f8e0d794b4',
            'Daemon is not responding'
          )}
        </div>
        <div className="text-muted-foreground">
          {t(
            'auto.components.status.bar.ResourceUsageStatusSegment.f85af9cda6',
            'Resource snapshots and terminal sessions are unavailable.'
          )}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => daemonActions.setPending('restart')}
        disabled={daemonActions.isBusy}
      >
        <RotateCw className="mr-1 size-3" />
        {t('auto.components.status.bar.ResourceUsageStatusSegment.93b0de3c21', 'Restart')}
      </Button>
    </div>
  )
}

export function renderSessionsOnlyErrorBanner(t: Translate = translate): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
      role="status"
    >
      <AlertTriangle className="size-3 shrink-0 text-yellow-500" />
      <span>
        {t(
          'auto.components.status.bar.ResourceUsageStatusSegment.e7cf14ec78',
          'Terminal sessions unavailable. The list may be stale.'
        )}
      </span>
    </div>
  )
}

export function renderResourceUsageSummary(
  {
    totalCpu,
    totalMemory,
    memoryMetricCopy,
    commitBadgeLabel,
    commitMetricCopy,
    commitToneClass,
    orphanCount
  }: {
    totalCpu: number
    totalMemory: number
    memoryMetricCopy: ReturnType<typeof getResourceMemoryMetricCopy>
    commitBadgeLabel: string | null
    commitMetricCopy: ReturnType<typeof getResourceCommitMetricCopy> | null
    commitToneClass: string | null
    orphanCount: number
  },
  t: Translate = translate
): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-border px-3 py-2 text-xs tabular-nums">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-medium text-foreground">{formatCpu(totalCpu)}</span>
        <span className="font-medium text-foreground">
          {formatMemory(totalMemory)}{' '}
          <span className="font-normal text-muted-foreground">{memoryMetricCopy.summaryLabel}</span>
        </span>
        {commitBadgeLabel && commitMetricCopy && (
          <span className={cn('font-medium', commitToneClass ?? 'text-foreground')}>
            {commitBadgeLabel}{' '}
            <span className="font-normal text-muted-foreground">
              {commitMetricCopy.summaryLabel}
            </span>
          </span>
        )}
        {orphanCount > 0 && (
          <span className="ml-auto shrink-0 text-status-warning-text" aria-live="polite">
            {t(
              'auto.components.status.bar.ResourceUsageStatusSegment.orphanCount',
              '{{count}} orphans',
              { count: orphanCount, defaultValue_one: '{{count}} orphan' }
            )}
          </span>
        )}
      </div>
      <details className="mt-1.5 text-muted-foreground">
        <summary className="cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('resourceManager.metricDetails', 'Metric details')}
        </summary>
        <div className="mt-1.5 space-y-1.5">
          <p>
            {t(
              'auto.components.status.bar.ResourceUsageStatusSegment.1fedf94eae',
              'Combined CPU load. Values above 100% mean more than one core is working at once.'
            )}
          </p>
          <p>{memoryMetricCopy.description}</p>
          {commitBadgeLabel && commitMetricCopy ? <p>{commitMetricCopy.description}</p> : null}
        </div>
      </details>
    </div>
  )
}
