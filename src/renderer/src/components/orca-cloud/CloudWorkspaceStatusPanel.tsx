import React from 'react'
import { Archive, ArchiveRestore, Cloud, Loader2, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  formatBytes,
  formatCents,
  formatDuration,
  formatHours,
  percentOf,
  type CloudDotState
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { refreshCloudWorkspaceStatus, type CloudStatusEntry } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CloudStateDot } from './CloudStateDot'
import { cloudStateDetail, cloudStateLabel } from './cloud-state-copy'

type Actions = {
  onRestart: () => void
  onArchive: () => void
  onUnarchive: () => void
}

function Meter({ label, value, percent, warn }: { label: string; value: string; percent: number; warn: boolean }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
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

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

/**
 * The status panel for one Orca Cloud workspace (hover card body). Shows state, live VM metrics,
 * uptime and cost so far, and the actions that state allows. Read-only while a request is pending.
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
  const status = entry?.status ?? null
  const metrics = status?.metrics ?? null
  const firstLoad = !status && (entry?.loading ?? true) && !entry?.error
  const busy = pending !== undefined
  const canRestart = state === 'running' || state === 'unresponsive' || state === 'failed'
  const canArchive = state === 'running' || state === 'sleeping' || state === 'unresponsive'
  const memPercent = metrics ? percentOf(metrics.memUsedBytes, metrics.memTotalBytes) : 0
  const diskPercent = metrics ? percentOf(metrics.diskUsedBytes, metrics.diskTotalBytes) : 0

  return (
    <div className={cn('flex flex-col gap-3 text-xs', className)} data-cloud-status-panel={workspaceId}>
      <div className="flex items-start gap-2">
        <Cloud className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground">{t('orcaCloudWorkspace.title', 'Orca Cloud')}</span>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 text-foreground" role="status">
              <CloudStateDot state={state} />
              {cloudStateLabel(state, t)}
            </span>
          </div>
          <p className="mt-0.5 text-muted-foreground">{cloudStateDetail(state, t)}</p>
        </div>
      </div>

      {firstLoad ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t('orcaCloudWorkspace.loading', 'Loading status')}>
          {[0, 1, 2].map((row) => (
            <span key={row} className="h-3 rounded bg-muted motion-safe:animate-pulse" />
          ))}
        </div>
      ) : !status && entry?.error ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5">
          <span className="text-muted-foreground">
            {t('orcaCloudWorkspace.statusUnavailable', 'Status unavailable right now.')}
          </span>
          <Button size="xs" variant="ghost" onClick={() => void refreshCloudWorkspaceStatus(workspaceId)}>
            {t('orcaCloudWorkspace.retry', 'Retry')}
          </Button>
        </div>
      ) : (
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
          {status ? (
            <dl className="flex flex-col gap-1">
              {status.uptimeMs !== null ? (
                <Fact label={t('orcaCloudWorkspace.uptime', 'Up for')} value={formatDuration(status.uptimeMs)} />
              ) : null}
              <Fact
                label={t('orcaCloudWorkspace.used', 'Used')}
                value={t('orcaCloudWorkspace.usedValue', '{{hours}} · {{cost}} so far', {
                  hours: formatHours(status.usage.totalMs),
                  cost: formatCents(status.usage.costCents)
                })}
              />
              {status.archive?.expiresAt ? (
                <Fact
                  label={t('orcaCloudWorkspace.keptUntil', 'Kept until')}
                  value={new Date(status.archive.expiresAt).toLocaleDateString(getIntlLocale())}
                />
              ) : null}
            </dl>
          ) : null}
        </>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground" aria-live="polite">
          {entry?.fetchedAt
            ? entry.error
              ? t('orcaCloudWorkspace.staleSince', 'Last known · {{ago}} ago', {
                  ago: formatDuration(now - entry.fetchedAt)
                })
              : t('orcaCloudWorkspace.updatedAgo', 'Updated {{ago}} ago', {
                  ago: formatDuration(Math.max(0, now - entry.fetchedAt))
                })
            : null}
        </span>
        <div className="flex items-center gap-1">
          {state === 'archived' ? (
            <Button size="xs" onClick={actions.onUnarchive} disabled={busy}>
              {pending === 'unarchive' ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
              {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
            </Button>
          ) : null}
          {canArchive ? (
            <Button size="xs" variant="ghost" onClick={actions.onArchive} disabled={busy}>
              {pending === 'archive' ? <Loader2 className="animate-spin" /> : <Archive />}
              {t('orcaCloudWorkspace.archive', 'Archive')}
            </Button>
          ) : null}
          {canRestart ? (
            <Button
              size="xs"
              variant={state === 'running' ? 'ghost' : 'default'}
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
    </div>
  )
}
