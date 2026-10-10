import React from 'react'
import { AlertTriangle, MemoryStick, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DaemonActionsApi } from '../shared/useDaemonActions'
import type {
  getResourceCommitMetricCopy,
  getResourceMemoryMetricCopy
} from './resource-memory-metric-copy'
import { formatCpu, formatMemory } from './resource-usage-metrics'

export function renderResourceUsagePopoverHeader({
  daemonActions
}: {
  daemonActions: DaemonActionsApi
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
        <MemoryStick className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {translate('auto.components.status.bar.StatusBar.d1e1a7a6bf', 'Resource Manager')}
        </span>
      </div>

      <div className="flex items-center gap-0.5">
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => daemonActions.setPending('restart')}
              disabled={daemonActions.isBusy}
              aria-label={translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.c9382662bb',
                'Restart daemon'
              )}
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <RotateCw className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.c9382662bb',
              'Restart daemon'
            )}
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => daemonActions.setPending('killAll')}
              disabled={daemonActions.isBusy}
              aria-label={translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.bd19fd7a59',
                'Kill all sessions'
              )}
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
            >
              <Trash2 className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.bd19fd7a59',
              'Kill all sessions'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function renderDaemonUnreachableBanner({
  daemonActions
}: {
  daemonActions: DaemonActionsApi
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 border-b border-border bg-yellow-500/10 px-3 py-2 text-[11px] text-foreground">
      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-yellow-500" />
      <div className="flex-1">
        <div className="font-medium">
          {translate(
            'auto.components.status.bar.ResourceUsageStatusSegment.f8e0d794b4',
            'Daemon is not responding'
          )}
        </div>
        <div className="text-muted-foreground">
          {translate(
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
        {translate('auto.components.status.bar.ResourceUsageStatusSegment.93b0de3c21', 'Restart')}
      </Button>
    </div>
  )
}

export function renderSessionsOnlyErrorBanner(): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
      role="status"
    >
      <AlertTriangle className="size-3 shrink-0 text-yellow-500" />
      <span>
        {translate(
          'auto.components.status.bar.ResourceUsageStatusSegment.e7cf14ec78',
          'Terminal sessions unavailable. The list may be stale.'
        )}
      </span>
    </div>
  )
}

export function renderResourceUsageSummary({
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
}): React.JSX.Element {
  return (
    <div className="px-3 py-2 border-b border-border flex items-baseline justify-between gap-3 text-xs tabular-nums">
      <div className="flex items-baseline gap-3 min-w-0">
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
            >
              {formatCpu(totalCpu)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.1fedf94eae',
              'Combined CPU load. Values above 100% mean more than one core is working at once.'
            )}
          </TooltipContent>
        </Tooltip>
        <span className="text-muted-foreground/50">·</span>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
            >
              {formatMemory(totalMemory)}{' '}
              <span className="font-normal text-muted-foreground">
                {memoryMetricCopy.summaryLabel}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
            {memoryMetricCopy.description}
          </TooltipContent>
        </Tooltip>
        {commitBadgeLabel && commitMetricCopy && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className={cn(
                    'font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded',
                    commitToneClass ?? 'text-foreground'
                  )}
                >
                  {commitBadgeLabel}{' '}
                  <span className="font-normal text-muted-foreground">
                    {commitMetricCopy.summaryLabel}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                {commitMetricCopy.description}
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
      {orphanCount > 0 && (
        <span className="shrink-0 text-yellow-500" aria-live="polite">
          {orphanCount === 1
            ? translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.30ff2c3c31',
                '{{value0}} orphan',
                { value0: orphanCount }
              )
            : translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.b8f4a2c1d0e3',
                '{{value0}} orphans',
                { value0: orphanCount }
              )}
        </span>
      )}
    </div>
  )
}
