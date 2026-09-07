import React, { memo, useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AppMemory, UsageValues } from '../../../../shared/process-stats-types'
import type { Metric } from './resource-usage-merge-types'

export const METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
export const CPU_COLUMN_CLS = 'w-12 text-right'
export const MEM_COLUMN_CLS = 'w-16 text-right'
// Why: every row and the header reserve this trailing gutter so CPU/Memory columns align whether or not the row has a kill-X.
export const ROW_TRAILING_GUTTER_CLS = 'w-5 shrink-0 flex items-center justify-end'

// ─── Formatters ─────────────────────────────────────────────────────

export function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatCpu(percent: number): string {
  return `${percent.toFixed(1)}%`
}

function formatMetricCpu(value: Metric): string {
  return value === null ? '—' : formatCpu(value)
}

function formatMetricMemory(value: Metric): string {
  return value === null ? '—' : formatMemory(value)
}

// ─── Sparkline ──────────────────────────────────────────────────────

type SparklineProps = {
  samples: number[]
  width?: number
  height?: number
}

function SparklineImpl({ samples, width = 48, height = 14 }: SparklineProps): React.JSX.Element {
  const points = useMemo(() => {
    const safe = Array.isArray(samples) ? samples : []
    if (safe.length < 2) {
      const midY = (height / 2).toFixed(1)
      return `0,${midY} ${width},${midY}`
    }

    let min = safe[0]
    let max = safe[0]
    for (const v of safe) {
      if (v < min) {
        min = v
      }
      if (v > max) {
        max = v
      }
    }
    const range = max - min || 1
    const stepX = width / (safe.length - 1)

    const out: string[] = []
    for (let i = 0; i < safe.length; i++) {
      const x = (i * stepX).toFixed(1)
      const y = (height - ((safe[i] - min) / range) * height).toFixed(1)
      out.push(`${x},${y}`)
    }
    return out.join(' ')
  }, [samples, width, height])

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-muted-foreground/70"
      />
    </svg>
  )
}

export const Sparkline = memo(SparklineImpl, (a, b) => {
  if (a.width !== b.width || a.height !== b.height) {
    return false
  }
  const sa = Array.isArray(a.samples) ? a.samples : []
  const sb = Array.isArray(b.samples) ? b.samples : []
  if (sa === sb) {
    return true
  }
  if (sa.length !== sb.length) {
    return false
  }
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) {
      return false
    }
  }
  return true
})

// ─── Leaf UI: metric row ────────────────────────────────────────────

export function MetricPair({
  cpu,
  memory,
  size = 'base'
}: {
  cpu: Metric
  memory: Metric
  size?: 'base' | 'small'
}): React.JSX.Element {
  const textCls = size === 'small' ? 'text-[11px]' : 'text-xs'
  const muted = cpu === null && memory === null
  return (
    <div
      className={cn(
        METRIC_COLUMNS_CLS,
        textCls,
        muted ? 'text-muted-foreground/50' : 'text-muted-foreground'
      )}
    >
      <span className={CPU_COLUMN_CLS}>{formatMetricCpu(cpu)}</span>
      <span className={MEM_COLUMN_CLS}>{formatMetricMemory(memory)}</span>
    </div>
  )
}

function AppSubRow({ label, values }: { label: string; values: UsageValues }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 pl-6 flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground truncate">{label}</span>
      <div className="flex items-center gap-2 shrink-0">
        <MetricPair cpu={values.cpu} memory={values.memory} size="small" />
        <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
      </div>
    </div>
  )
}

export function AppSection({
  app,
  isCollapsed,
  onToggle
}: {
  app: AppMemory
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="border-t border-border/50">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className="pl-2 py-2 pr-0.5 transition-colors hover:bg-muted/50"
          aria-label={
            isCollapsed
              ? translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.e419d27083',
                  'Expand Orca'
                )
              : translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.53dd5560ae',
                  'Collapse Orca'
                )
          }
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </button>
        <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
            {translate('auto.components.status.bar.ResourceUsageStatusSegment.288a4dd177', 'Orca')}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <Sparkline samples={app.history} />
            <MetricPair cpu={app.cpu} memory={app.memory} />
            <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
          </div>
        </div>
      </div>
      {!isCollapsed && (
        <div className="border-t border-border/30">
          <AppSubRow
            label={translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.81cd37af99',
              'Main'
            )}
            values={app.main}
          />
          <AppSubRow
            label={translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.d406915b78',
              'Renderer'
            )}
            values={app.renderer}
          />
          {(app.other.cpu > 0 || app.other.memory > 0) && (
            <AppSubRow
              label={translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.0f9e50eb07',
                'Other'
              )}
              values={app.other}
            />
          )}
        </div>
      )}
    </div>
  )
}
