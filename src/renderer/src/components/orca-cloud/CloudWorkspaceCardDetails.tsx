// "Details" in the cloud workspace card: the CPU, memory and disk bars, uptime and sandbox hours.
// Opt-in (⋯ → Details, or the disclosure under the usage line); the default card stays one line.
import React from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { getIntlLocale } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import {
  formatBytes,
  formatDuration,
  formatShortDate,
  percentOf
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  ORCA_CLOUD_SANDBOX_SPEC,
  type HostedWorkspaceStatus
} from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'

const METER_ROWS = 3

/** "14.6": the label already says sandbox hours. */
function sandboxHoursNumber(ms: number): string {
  const hours = ms / 3_600_000
  const digits = hours >= 100 ? 0 : 1
  return new Intl.NumberFormat(getIntlLocale(), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(hours)
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
            warn ? 'bg-status-warning' : 'bg-foreground/60'
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="tabular-nums whitespace-nowrap text-foreground">{value}</span>
    </div>
  )
}

/** Same grid as the meters, so the loaded card doesn't jump. */
export function MeterSkeleton(): React.JSX.Element {
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

function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

export function CloudWorkspaceCardDetails({
  id,
  status,
  showMeters,
  restarting
}: {
  id: string
  status: HostedWorkspaceStatus
  showMeters: boolean
  restarting: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const metrics = status.metrics
  const memPercent = metrics ? percentOf(metrics.memUsedBytes, metrics.memTotalBytes) : 0
  const diskPercent = metrics ? percentOf(metrics.diskUsedBytes, metrics.diskTotalBytes) : 0
  return (
    <div id={id} className="flex flex-col gap-2" data-cloud-card-details>
      {showMeters && metrics && !restarting ? (
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
              // The plan's memory, as on the usage line (the VM reports a little more).
              total: t('orcaCloudWorkspace.bytes.gb', '{{value}} GB', {
                value: ORCA_CLOUD_SANDBOX_SPEC.memoryGb
              })
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
          label={t('orcaCloudWorkspace.card.totalSandboxHours', 'Total sandbox hours')}
          value={sandboxHoursNumber(status.usage.totalMs)}
        />
        {status.archive?.expiresAt ? (
          <Fact
            label={t('orcaCloudWorkspace.keptUntil', 'Kept until')}
            value={formatShortDate(status.archive.expiresAt)}
          />
        ) : null}
      </dl>
    </div>
  )
}
