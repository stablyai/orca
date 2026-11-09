import React, { useState } from 'react'
import { Archive, ArchiveRestore, Cloud, Loader2, RotateCw } from 'lucide-react'
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

type Actions = {
  onRestart: () => void
  onArchive: () => void
  onUnarchive: () => void
}

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
            warn ? 'bg-amber-500' : 'bg-foreground/60'
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

/**
 * The status panel for one Orca Cloud workspace (sidebar popover body): state, live metrics,
 * uptime and cost since created, and the actions the state allows. Archive asks once.
 */
export function CloudWorkspaceStatusPanel({
  workspaceId,
  state,
  entry,
  pending,
  actions,
  className
}: {
  workspaceId: string
  state: CloudDotState
  entry: CloudStatusEntry | undefined
  pending: 'restart' | 'archive' | 'unarchive' | undefined
  actions: Actions
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(5_000)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const status = entry?.status ?? null
  const metrics = status?.metrics ?? null
  const unavailable = !status && Boolean(entry?.error)
  const firstLoad = !status && !entry?.error
  const busy = pending !== undefined
  const canRestart = state === 'running' || state === 'unresponsive' || state === 'failed'
  const restartPrimary = state === 'unresponsive' || state === 'failed'
  const canArchive = state === 'running' || state === 'sleeping' || state === 'unresponsive'
  const memPercent = metrics ? percentOf(metrics.memUsedBytes, metrics.memTotalBytes) : 0
  const diskPercent = metrics ? percentOf(metrics.diskUsedBytes, metrics.diskTotalBytes) : 0
  const detail = unavailable ? null : cloudStateDetail(state, t)

  return (
    <div
      className={cn('flex flex-col gap-3 text-xs', className)}
      data-cloud-status-panel={workspaceId}
    >
      <div className="flex items-start gap-2">
        <Cloud className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground">
              {t('orcaCloudWorkspace.title', 'Orca Cloud')}
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              ·
            </span>
            {unavailable ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span aria-hidden="true" className="inline-block size-2 rounded-full bg-muted-foreground/60" />
                {t('orcaCloudWorkspace.statusUnavailable', 'Status unavailable')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <CloudStateDot state={state} size="md" />
                {cloudStateLabel(state, t)}
              </span>
            )}
          </div>
          {detail ? <p className="mt-0.5 text-muted-foreground">{detail}</p> : null}
        </div>
        {unavailable ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void refreshCloudWorkspaceStatus(workspaceId)}
          >
            {t('orcaCloudWorkspace.retry', 'Retry')}
          </Button>
        ) : null}
      </div>

      {firstLoad ? (
        <div
          className="flex flex-col gap-2"
          aria-busy="true"
          aria-label={t('orcaCloudWorkspace.loading', 'Loading status')}
        >
          {[70, 85, 60].map((width) => (
            <span
              key={width}
              className="h-3 rounded bg-muted motion-safe:animate-pulse"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      ) : status ? (
        <>
          {metrics && (state === 'running' || state === 'unresponsive') ? (
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
            {status.uptimeMs !== null ? (
              <Fact
                label={t('orcaCloudWorkspace.uptime', 'Up for')}
                value={formatDuration(status.uptimeMs)}
              />
            ) : null}
            <Fact
              label={t('orcaCloudWorkspace.used', 'Used')}
              value={t('orcaCloudWorkspace.usedSinceCreated', '{{hours}} · {{cost}} since created', {
                hours: formatHours(status.usage.totalMs),
                cost: formatCents(status.usage.costCents)
              })}
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

      {confirmArchive ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2"
          role="group"
          aria-label={t('orcaCloudWorkspace.archiveConfirmLabel', 'Confirm archive')}
        >
          <p className="text-foreground">
            {t(
              'orcaCloudWorkspace.archiveConfirm',
              'Archive this workspace? It stops and is kept as a snapshot you can unarchive.'
            )}
          </p>
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" onClick={() => setConfirmArchive(false)}>
              {t('orcaCloudWorkspace.cancel', 'Cancel')}
            </Button>
            <Button
              size="xs"
              autoFocus
              onClick={() => {
                setConfirmArchive(false)
                actions.onArchive()
              }}
            >
              <Archive />
              {t('orcaCloudWorkspace.archive', 'Archive')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-6 items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
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
          <div className="flex items-center gap-1">
            {state === 'archived' ? (
              <Button
                size="xs"
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) {
                    actions.onUnarchive()
                  }
                }}
                className={cn(busy && 'opacity-60')}
              >
                {pending === 'unarchive' ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
                {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
              </Button>
            ) : null}
            {canArchive ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setConfirmArchive(true)}
                disabled={busy}
              >
                {pending === 'archive' ? <Loader2 className="animate-spin" /> : <Archive />}
                {t('orcaCloudWorkspace.archiveEllipsis', 'Archive…')}
              </Button>
            ) : null}
            {canRestart ? (
              <Button
                size="xs"
                variant={restartPrimary ? 'default' : 'ghost'}
                onClick={actions.onRestart}
                disabled={busy}
              >
                {pending === 'restart' ? <Loader2 className="animate-spin" /> : <RotateCw />}
                {pending === 'restart'
                  ? t('orcaCloudWorkspace.restarting', 'Restarting…')
                  : t('orcaCloudWorkspace.restart', 'Restart')}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
