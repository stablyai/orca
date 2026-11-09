import React from 'react'
import { AlertCircle, Archive, ArchiveRestore, Cloud, Loader2, Play, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import {
  formatBytes,
  formatCents,
  formatDuration,
  formatHours,
  formatShortDate,
  percentOf,
  showUpdatedAgo,
  type CloudDotState
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  refreshCloudWorkspaceStatus,
  type CloudStatusEntry
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CloudStateDot } from './CloudStateDot'
import { cloudStateDetail, cloudStateLabel } from './cloud-state-copy'

export type CloudPanelActions = {
  onWake: () => void
  onRestart: () => void
  onArchive: () => void
  onUnarchive: () => void
}

type Pending = 'restart' | 'archive' | 'unarchive' | undefined

const METER_ROWS = 3

function Meter({
  label,
  value,
  percent,
  warn
}: {
  label: string
  value: string
  percent: number
  warn: boolean
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={value}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            'block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500',
            warn ? 'bg-status-warning' : 'bg-foreground/60'
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="tabular-nums whitespace-nowrap text-foreground">{value}</span>
    </div>
  )
}

/** Same grid as the meters, so the loaded panel doesn't jump. */
function MeterSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" aria-hidden="true">
      {Array.from({ length: METER_ROWS }, (_, row) => (
        <div key={row} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
          <span className="h-3 w-10 rounded bg-muted motion-safe:animate-pulse" />
          <span className="h-1 rounded-full bg-muted" />
          <span className="h-3 w-20 rounded bg-muted motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  )
}

function Fact({
  label,
  value,
  muted = false
}: {
  label: string
  value: React.ReactNode
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', muted ? 'text-muted-foreground' : 'text-foreground')}>
        {value}
      </dd>
    </div>
  )
}

/** Pending buttons stay focused and announced: aria-disabled + aria-busy, never `disabled`. */
function busyProps(isBusy: boolean, anyBusy: boolean, onClick: () => void) {
  return {
    'aria-disabled': anyBusy || undefined,
    'aria-busy': isBusy || undefined,
    onClick: () => {
      if (!anyBusy) {
        onClick()
      }
    }
  }
}

/**
 * The status panel for one Orca Cloud workspace (sidebar popover body): state, live metrics,
 * uptime and usage, and the actions the state allows.
 */
export function CloudWorkspaceStatusPanel({
  workspaceId,
  state: rawState,
  entry,
  pending,
  actions,
  className
}: {
  workspaceId: string
  state: CloudDotState
  entry: CloudStatusEntry | undefined
  pending: Pending
  actions: CloudPanelActions
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(5_000)
  // A restart in flight is a wake, whatever the last status read said.
  const restarting = pending === 'restart'
  const state: CloudDotState = restarting ? 'waking' : rawState
  const status = entry?.status ?? null
  const metrics = status?.metrics ?? null
  const unavailable = !status && Boolean(entry?.error)
  const firstLoad = !status && !entry?.error
  const anyBusy = pending !== undefined
  const canRestart = state === 'running' || state === 'unresponsive' || state === 'failed'
  const restartPrimary = state === 'unresponsive' || state === 'failed'
  const canArchive = state === 'running' || state === 'sleeping' || state === 'unresponsive'
  const memPercent = metrics ? percentOf(metrics.memUsedBytes, metrics.memTotalBytes) : 0
  const diskPercent = metrics ? percentOf(metrics.diskUsedBytes, metrics.diskTotalBytes) : 0
  const detail = unavailable
    ? null
    : restarting
      ? t('orcaCloudWorkspace.detail.restarting', 'Restarting… Orca resumes your agents after the restart.')
      : cloudStateDetail(state, t)
  const showMeters = Boolean(metrics) && (state === 'running' || state === 'unresponsive')

  return (
    <div
      className={cn('flex flex-col gap-3 text-xs', className)}
      data-cloud-status-panel={workspaceId}
    >
      <div className="flex items-start gap-2">
        <Cloud className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="font-medium text-foreground">
              {t('orcaCloudWorkspace.title', 'Orca Cloud')}
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              ·
            </span>
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <CloudStateDot state={unavailable ? 'unknown' : state} size="md" />
              {unavailable
                ? t('orcaCloudWorkspace.statusUnavailable', 'Status unavailable')
                : restarting
                  ? t('orcaCloudWorkspace.state.restarting', 'Restarting')
                  : cloudStateLabel(state, t)}
            </span>
          </div>
          {detail ? <p className="mt-0.5 text-muted-foreground">{detail}</p> : null}
        </div>
      </div>

      {unavailable ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"
        >
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
            {t('orcaCloudWorkspace.statusUnavailableDetail', 'Orca Cloud didn’t answer.')}
          </span>
          <Button size="xs" variant="outline" onClick={() => void refreshCloudWorkspaceStatus(workspaceId)}>
            <RotateCw />
            {t('orcaCloudWorkspace.retry', 'Retry')}
          </Button>
        </div>
      ) : firstLoad ? (
        <div aria-busy="true" aria-label={t('orcaCloudWorkspace.loading', 'Loading status')}>
          <MeterSkeleton />
        </div>
      ) : status ? (
        <>
          {showMeters && !restarting && metrics ? (
            <div className="flex flex-col gap-1.5">
              <Meter
                label={t('orcaCloudWorkspace.cpu', 'CPU')}
                value={t('orcaCloudWorkspace.cpuValue', '{{percent}}% of {{cpus}} vCPU', {
                  percent: metrics.cpuPercent,
                  cpus: metrics.cpus
                })}
                percent={metrics.cpuPercent}
                warn={metrics.cpuPercent >= 90}
              />
              <Meter
                label={t('orcaCloudWorkspace.memory', 'Memory')}
                value={`${formatBytes(metrics.memUsedBytes)} / ${formatBytes(metrics.memTotalBytes)}`}
                percent={memPercent}
                warn={memPercent >= 90}
              />
              <Meter
                label={t('orcaCloudWorkspace.disk', 'Disk')}
                value={`${formatBytes(metrics.diskUsedBytes)} / ${formatBytes(metrics.diskTotalBytes)}`}
                percent={diskPercent}
                warn={diskPercent >= 90}
              />
            </div>
          ) : null}
          <dl className="flex flex-col gap-1">
            {status.uptimeMs !== null && !restarting ? (
              <Fact
                label={t('orcaCloudWorkspace.uptime', 'Up for')}
                value={formatDuration(status.uptimeMs)}
              />
            ) : null}
            <Fact
              label={t('orcaCloudWorkspace.usedSinceCreatedLabel', 'Used since created')}
              value={t('orcaCloudWorkspace.sandboxHours', '{{hours}} sandbox time', {
                hours: formatHours(status.usage.totalMs)
              })}
            />
            <Fact
              muted
              label={t('orcaCloudWorkspace.estimatedCost', 'Est. cost if over plan')}
              value={formatCents(status.usage.costCents)}
            />
            {status.archive?.expiresAt ? (
              <Fact
                label={t('orcaCloudWorkspace.keptUntil', 'Kept until')}
                value={formatShortDate(status.archive.expiresAt)}
              />
            ) : null}
          </dl>
        </>
      ) : null}

      <div className="flex min-h-6 items-center justify-between gap-2 whitespace-nowrap">
        {/* Not a live region: a ticking "ago" would announce itself every few seconds. */}
        <span className="truncate text-[11px] text-muted-foreground">
          {entry?.fetchedAt && showUpdatedAgo(entry.fetchedAt, now)
            ? entry.error
              ? t('orcaCloudWorkspace.staleSince', 'Last known · {{ago}} ago', {
                  ago: formatDuration(now - entry.fetchedAt)
                })
              : t('orcaCloudWorkspace.updatedAgo', 'Updated {{ago}} ago', {
                  ago: formatDuration(now - entry.fetchedAt)
                })
            : null}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {canArchive && !restarting ? (
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              {...busyProps(pending === 'archive', anyBusy, actions.onArchive)}
            >
              {pending === 'archive' ? <Loader2 className="animate-spin" /> : <Archive />}
              {t('orcaCloudWorkspace.archive', 'Archive')}
            </Button>
          ) : null}
          {state === 'archived' ? (
            <Button size="xs" {...busyProps(pending === 'unarchive', anyBusy, actions.onUnarchive)}>
              {pending === 'unarchive' ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
              {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
            </Button>
          ) : null}
          {state === 'sleeping' ? (
            <Button size="xs" {...busyProps(false, anyBusy, actions.onWake)}>
              <Play />
              {t('orcaCloudWorkspace.wake', 'Wake')}
            </Button>
          ) : null}
          {canRestart || restarting ? (
            <Button
              size="xs"
              variant={restartPrimary || restarting ? 'default' : 'ghost'}
              {...busyProps(restarting, anyBusy, actions.onRestart)}
            >
              {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />}
              {restarting
                ? t('orcaCloudWorkspace.restarting', 'Restarting…')
                : t('orcaCloudWorkspace.restart', 'Restart')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
