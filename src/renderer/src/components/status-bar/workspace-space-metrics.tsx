import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { translate } from '@/i18n/i18n'
import {
  getWorkspaceSpaceScanDateTimeLabel,
  getWorkspaceSpaceScanTimeLabel
} from './workspace-space-format'
import { formatShortTimeAgo } from '@/lib/short-time-ago'

export function Metric({
  label,
  value,
  title,
  shortLabel,
  shortValue
}: {
  label: string
  value: string
  title?: string
  shortLabel?: string
  shortValue?: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 md:px-3">
      <div className="min-w-0 truncate text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        {shortLabel ? (
          <>
            <span className="md:hidden">{shortLabel}</span>
            <span className="hidden md:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </div>
      <div className="shrink-0 text-sm font-semibold tabular-nums" title={title}>
        {shortValue ? (
          <>
            <span className="md:hidden">{shortValue}</span>
            <span className="hidden md:inline">{value}</span>
          </>
        ) : (
          value
        )}
      </div>
    </div>
  )
}

export function UpdatedMetric({
  scannedAt,
  isScanning
}: {
  scannedAt: number | null
  isScanning: boolean
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (scannedAt === null) {
      return
    }
    // Refresh new scans immediately, then pause minute ticks while the window is hidden.
    setNow(Date.now())
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 60_000 })
  }, [scannedAt])

  return (
    <Metric
      label={translate(
        'auto.components.status.bar.WorkspaceSpaceManagerPanel.52b629eb84',
        'Updated'
      )}
      title={scannedAt === null ? undefined : getWorkspaceSpaceScanDateTimeLabel(scannedAt)}
      shortValue={scannedAt === null ? undefined : formatShortTimeAgo(scannedAt, now)}
      value={
        scannedAt === null
          ? isScanning
            ? 'Scanning'
            : '—'
          : getWorkspaceSpaceScanTimeLabel(scannedAt, now)
      }
    />
  )
}
