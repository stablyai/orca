/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: the relative time clock advances from a wall-clock interval, which is an external timer rather than render-derived state. */
import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { translate } from '@/i18n/i18n'
import {
  getWorkspaceSpaceScanDateTimeLabel,
  getWorkspaceSpaceScanTimeLabel
} from './workspace-space-format'

export function Metric({
  label,
  value,
  title
}: {
  label: string
  value: string
  title?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums" title={title}>
        {value}
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
    // Refresh once immediately (unconditional, as before) so a rescan that lands
    // while hidden isn't shown stale, then pause the ongoing 60s tick while the
    // window is hidden — same visibility-gated pattern as useNow.
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
