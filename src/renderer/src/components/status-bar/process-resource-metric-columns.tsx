import React from 'react'
import { cn } from '@/lib/utils'
import {
  formatOptionalProcessCpuPercent,
  formatOptionalProcessMemoryBytes,
  formatOptionalProcessUptime
} from '@/lib/format-process-resource-usage'
import type { ProcessMetricSortOption } from '@/lib/sort-by-process-metric'
import { translate } from '@/i18n/i18n'

/** Shared with the Resource Manager tree so both surfaces line up pixel-for-pixel. */
export const METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
export const CPU_COLUMN_CLS = 'w-12 text-right'
export const MEM_COLUMN_CLS = 'w-16 text-right'
export const UPTIME_COLUMN_CLS = 'w-14 text-right'
// Why: rows with a trailing kill/action affordance and rows without it both
// reserve this gutter, so the metric columns line up regardless.
export const ROW_TRAILING_GUTTER_CLS = 'w-5 shrink-0 flex items-center justify-end'

export function MetricPair({
  cpu,
  memory,
  uptimeSeconds,
  showUptime = false,
  size = 'base'
}: {
  cpu: number | null | undefined
  memory: number | null | undefined
  /** Ignored unless `showUptime` — pass `null` at aggregation levels with no single-process age. */
  uptimeSeconds?: number | null
  showUptime?: boolean
  size?: 'base' | 'small'
}): React.JSX.Element {
  const textCls = size === 'small' ? 'text-[11px]' : 'text-xs'
  const muted = cpu == null && memory == null
  return (
    <div
      className={cn(
        METRIC_COLUMNS_CLS,
        textCls,
        muted ? 'text-muted-foreground/50' : 'text-muted-foreground'
      )}
    >
      <span className={CPU_COLUMN_CLS}>{formatOptionalProcessCpuPercent(cpu)}</span>
      <span className={MEM_COLUMN_CLS}>{formatOptionalProcessMemoryBytes(memory)}</span>
      {showUptime && (
        <span className={UPTIME_COLUMN_CLS}>{formatOptionalProcessUptime(uptimeSeconds)}</span>
      )}
    </div>
  )
}

export function ProcessMetricSortHeader({
  sortOption,
  onSortOptionChange,
  memoryLabel,
  showUptimeColumn = false,
  uptimeLabel
}: {
  sortOption: ProcessMetricSortOption
  onSortOptionChange: (option: ProcessMetricSortOption) => void
  memoryLabel: string
  showUptimeColumn?: boolean
  uptimeLabel?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-3 py-1 bg-muted/30 border-b border-border/50 text-[10px] uppercase tracking-wide shrink-0">
      <button
        type="button"
        onClick={() => onSortOptionChange('name')}
        className={cn(
          'hover:text-foreground transition-colors',
          sortOption === 'name' ? 'font-semibold text-foreground' : 'text-muted-foreground/80'
        )}
        aria-pressed={sortOption === 'name'}
      >
        {translate('components.statusBar.processResourceMetricColumns.name', 'Name')}
      </button>
      <div className="flex items-center gap-2 shrink-0">
        <div className={cn(METRIC_COLUMNS_CLS, 'text-[10px]')}>
          <button
            type="button"
            onClick={() => onSortOptionChange('cpu')}
            className={cn(
              CPU_COLUMN_CLS,
              'hover:text-foreground transition-colors',
              sortOption === 'cpu' ? 'font-semibold text-foreground' : 'text-muted-foreground/80'
            )}
            aria-pressed={sortOption === 'cpu'}
          >
            {translate('components.statusBar.processResourceMetricColumns.cpu', 'CPU')}
          </button>
          <button
            type="button"
            onClick={() => onSortOptionChange('memory')}
            className={cn(
              MEM_COLUMN_CLS,
              'hover:text-foreground transition-colors',
              sortOption === 'memory' ? 'font-semibold text-foreground' : 'text-muted-foreground/80'
            )}
            aria-pressed={sortOption === 'memory'}
          >
            {memoryLabel}
          </button>
          {showUptimeColumn && (
            <button
              type="button"
              onClick={() => onSortOptionChange('uptime')}
              className={cn(
                UPTIME_COLUMN_CLS,
                'hover:text-foreground transition-colors',
                sortOption === 'uptime'
                  ? 'font-semibold text-foreground'
                  : 'text-muted-foreground/80'
              )}
              aria-pressed={sortOption === 'uptime'}
            >
              {uptimeLabel}
            </button>
          )}
        </div>
        {/* Why: empty trailing gutter keeps CPU/Memory header cells aligned with rows that reserve this width for a kill-X. */}
        <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
      </div>
    </div>
  )
}
