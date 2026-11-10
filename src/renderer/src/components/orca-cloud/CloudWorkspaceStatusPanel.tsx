import React from 'react'
import { Archive, ArchiveRestore, Cloud, Laptop, Loader2, Play, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { cloudWorkspaceMoved } from '@/lib/orca-cloud/orca-cloud-move-store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { Skeleton } from '@/components/ui/skeleton'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import {
  formatBytes,
  formatCents,
  formatDuration,
  formatSandboxHours,
  formatShortDate,
  isWakeActive,
  percentOf,
  showUpdatedAgo,
  type CloudDotState
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  refreshCloudWorkspaceStatus,
  useCloudWorkspace,
  type CloudStatusEntry
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CloudStateDot } from './CloudStateDot'
import { cloudStateDetail, cloudStateLabel } from './cloud-state-copy'

export type CloudPanelActions = {
  onWake: () => void
  onRestart: () => void
  onArchive: () => void
  onUnarchive: () => void
  /** "Move to this computer"; absent where the move isn't offered (fixtures, older bridges). */
  onMoveToComputer?: () => void
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
          <Skeleton shape="small" className="h-3 w-10" />
          <Skeleton shape="circle" motion="still" className="h-1" />
          <Skeleton shape="small" className="h-3 w-20" />
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
  // A restart in flight is a wake, whatever the last status read said: one this panel started, or a
  // session rollover main is running (24h cap or "Restart now" from the toast).
  const rollover = useCloudWorkspace((s) => s.wake[workspaceId])
  const restarting =
    pending === 'restart' || (rollover?.source === 'restart' && isWakeActive(rollover, now))
  const state: CloudDotState = restarting ? 'waking' : rawState
  const status = entry?.status ?? null
  const metrics = status?.metrics ?? null
  const moved = cloudWorkspaceMoved(workspaceId)
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
      ? t('orcaCloudWorkspace.detail.restarting', 'Orca resumes your agents after the restart.')
      : cloudStateDetail(state, t)
  const showMeters = Boolean(metrics) && (state === 'running' || state === 'unresponsive')
  // Overage is what's billed beyond the plan; the status call doesn't carry it yet, so this stays 0
  // (no dollars shown) until billing reports it.
  const overageCents = 0
  const showAgo = Boolean(entry?.fetchedAt && showUpdatedAgo(entry.fetchedAt, now))
  const hasActions = canArchive || canRestart || restarting || state === 'archived'
  const showFooter = showAgo || hasActions

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
              {t('orcaCloudWorkspace.sandboxTitle', 'Sandbox')}
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
        <InlineError
          tone="neutral"
          title={t('orcaCloudWorkspace.statusUnavailableDetail', 'Orca Cloud didn’t answer.')}
          retryLabel={t('orcaCloudWorkspace.retry', 'Retry')}
          retrying={entry?.loading}
          onRetry={() => void refreshCloudWorkspaceStatus(workspaceId)}
          density="compact"
        />
      ) : firstLoad ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t('orcaCloudWorkspace.loading', 'Loading status')}
        >
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
                value={t('orcaCloudWorkspace.usedOfTotal', '{{used}} / {{total}}', {
                  used: formatBytes(metrics.memUsedBytes),
                  total: formatBytes(metrics.memTotalBytes)
                })}
                percent={memPercent}
                warn={memPercent >= 90}
              />
              <Meter
                label={t('orcaCloudWorkspace.disk', 'Disk')}
                value={t('orcaCloudWorkspace.usedOfTotal', '{{used}} / {{total}}', {
                  used: formatBytes(metrics.diskUsedBytes),
                  total: formatBytes(metrics.diskTotalBytes)
                })}
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
              label={t('orcaCloudWorkspace.usedLabel', 'Used')}
              value={formatSandboxHours(status.usage.totalMs)}
            />
            {/* Dollars only once the plan's included hours are used up (overage). */}
            {overageCents > 0 ? (
              <Fact
                muted
                label={t('orcaCloudWorkspace.overage', 'Overage so far')}
                value={formatCents(overageCents)}
              />
            ) : null}
            {status.archive?.expiresAt ? (
              <Fact
                label={t('orcaCloudWorkspace.keptUntil', 'Kept until')}
                value={formatShortDate(status.archive.expiresAt)}
              />
            ) : null}
            {moved ? (
              <div className="flex flex-col gap-0.5 pt-1">
                <dt className="text-muted-foreground">
                  {t('orcaCloudWorkspace.copiedOn', 'Moved to this computer · {{date}}', {
                    date: formatShortDate(moved.at)
                  })}
                </dt>
                {moved.localWorktreeId ? (
                  <dd>
                    <button
                      type="button"
                      className="text-foreground underline-offset-2 hover:underline focus-visible:outline-[var(--focus-ring)]"
                      onClick={() => activateAndRevealWorktree(moved.localWorktreeId!)}
                    >
                      {t('orcaCloudWorkspace.openLocal', 'Open local workspace')}
                    </button>
                  </dd>
                ) : null}
              </div>
            ) : null}
          </dl>
        </>
      ) : null}

      {showFooter ? (
        <div className="flex min-h-6 items-center justify-between gap-2 whitespace-nowrap">
          {/* Not a live region: a ticking "ago" would announce itself every few seconds. */}
          <span className="truncate text-[11px] text-muted-foreground">
            {showAgo && entry?.fetchedAt
              ? t('orcaCloudWorkspace.ago', '{{ago}} ago', {
                  ago: formatElapsedTime(now - entry.fetchedAt)
                })
              : null}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {actions.onMoveToComputer && canArchive && !restarting ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                aria-label={t('orcaCloudWorkspace.moveToComputer', 'Move to this computer')}
                {...busyProps(false, anyBusy, actions.onMoveToComputer)}
              >
                <Laptop />
                {moved
                  ? t('orcaCloudWorkspace.moveAgain', 'Move again')
                  : t('orcaCloudWorkspace.moveHere', 'Move here')}
              </Button>
            ) : null}
            {canArchive && !restarting ? (
              <Button
                size="xs"
                variant="quiet"
                {...busyProps(pending === 'archive', anyBusy, actions.onArchive)}
              >
                {pending === 'archive' ? <Loader2 className="animate-spin" /> : <Archive />}
                {t('orcaCloudWorkspace.archive', 'Archive')}
              </Button>
            ) : null}
            {state === 'archived' ? (
              <Button
                size="xs"
                {...busyProps(pending === 'unarchive', anyBusy, actions.onUnarchive)}
              >
                {pending === 'unarchive' ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ArchiveRestore />
                )}
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
      ) : null}
    </div>
  )
}
