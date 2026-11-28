import React from 'react'
import { AlertTriangle, MemoryStick, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { DaemonActionsApi } from '../../../shared/useDaemonActions'
import { formatMemory } from './resource-usage-metrics'
import type { ResourceOwnerSplit } from './resource-owner-split'
import { resourceOwnerLabels, type ResourceOwnerKey } from './resource-owner-labels'

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
        <span className="truncate">{t('resourceManager.resources', 'Resources')}</span>
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

const OWNER_SWATCH_CLS = {
  orca: 'bg-chart-2 dark:bg-chart-1',
  agents: 'bg-chart-5 dark:bg-chart-2',
  yourProcesses: 'bg-foreground/45'
} as const

const OWNERS = ['orca', 'agents', 'yourProcesses'] as const

function OwnerSwatch({ owner }: { owner: ResourceOwnerKey }): React.JSX.Element {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-sm', OWNER_SWATCH_CLS[owner])}
      aria-hidden
    />
  )
}

/** Each owner's share of their combined memory; shared pages make host-based shares unreliable. */
function barWidths(split: ResourceOwnerSplit): Record<ResourceOwnerKey, number> {
  const tracked = split.orca.memory + split.agents.memory + split.yourProcesses.memory
  const pct = (bytes: number): number => (tracked > 0 ? (bytes / tracked) * 100 : 0)
  return {
    orca: pct(split.orca.memory),
    agents: pct(split.agents.memory),
    yourProcesses: pct(split.yourProcesses.memory)
  }
}

export function renderResourceUsageSummary(
  {
    ownerSplit,
    commitBadgeLabel,
    commitToneClass,
    orphanCount
  }: {
    ownerSplit: ResourceOwnerSplit
    commitBadgeLabel: string | null
    commitToneClass: string | null
    orphanCount: number
  },
  t: Translate = translate
): React.JSX.Element {
  const labels = resourceOwnerLabels(t)
  const widths = barWidths(ownerSplit)
  const privateLabel = t(
    'resourceManager.owner.privateBytes',
    'Committed by Orca, agents and terminals'
  )
  return (
    <div className="shrink-0 border-b border-border px-3 pt-2 pb-1.5 text-xs tabular-nums">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        {OWNERS.map((owner) => (
          <span key={owner} className="inline-flex items-baseline gap-1 whitespace-nowrap">
            <span className="self-center">
              <OwnerSwatch owner={owner} />
            </span>
            <span className="text-muted-foreground">{labels[owner]}</span>
            <span className="font-medium text-foreground">
              {formatMemory(ownerSplit[owner].memory)}
            </span>
          </span>
        ))}
      </div>
      <div
        className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]"
        aria-hidden
      >
        {OWNERS.map((owner) => (
          <span
            key={owner}
            className={cn('h-full', OWNER_SWATCH_CLS[owner])}
            style={{ width: `${widths[owner]}%` }}
          />
        ))}
      </div>
      {(commitBadgeLabel !== null && commitToneClass) || orphanCount > 0 ? (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-2xs text-muted-foreground">
          {commitBadgeLabel !== null && commitToneClass && (
            <span className={cn('whitespace-nowrap', commitToneClass)}>
              {privateLabel} {commitBadgeLabel}
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
      ) : null}
    </div>
  )
}
