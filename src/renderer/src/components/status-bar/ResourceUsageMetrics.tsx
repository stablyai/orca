import React, { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { Metric } from './resource-usage-merge-types'

export const METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
export const CPU_COLUMN_CLS = 'w-12 text-right'
export const MEM_COLUMN_CLS = 'w-16 text-right'
export const ROW_TRAILING_GUTTER_CLS = 'w-5 shrink-0 flex items-center justify-end'

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
    for (const value of safe) {
      if (value < min) {
        min = value
      }
      if (value > max) {
        max = value
      }
    }
    const range = max - min || 1
    const stepX = width / (safe.length - 1)
    const out: string[] = []
    for (let index = 0; index < safe.length; index++) {
      const x = (index * stepX).toFixed(1)
      const y = (height - ((safe[index] - min) / range) * height).toFixed(1)
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

export const ResourceUsageSparkline = memo(SparklineImpl, (left, right) => {
  if (left.width !== right.width || left.height !== right.height) {
    return false
  }
  const leftSamples = Array.isArray(left.samples) ? left.samples : []
  const rightSamples = Array.isArray(right.samples) ? right.samples : []
  if (leftSamples === rightSamples) {
    return true
  }
  if (leftSamples.length !== rightSamples.length) {
    return false
  }
  for (let index = 0; index < leftSamples.length; index++) {
    if (leftSamples[index] !== rightSamples[index]) {
      return false
    }
  }
  return true
})

export function ResourceUsageMetricPair({
  cpu,
  memory,
  size = 'base'
}: {
  cpu: Metric
  memory: Metric
  size?: 'base' | 'small'
}): React.JSX.Element {
  const textClassName = size === 'small' ? 'text-[11px]' : 'text-xs'
  const muted = cpu === null && memory === null
  return (
    <div
      className={cn(
        METRIC_COLUMNS_CLS,
        textClassName,
        muted ? 'text-muted-foreground/50' : 'text-muted-foreground'
      )}
    >
      <span className={CPU_COLUMN_CLS}>{formatMetricCpu(cpu)}</span>
      <span className={MEM_COLUMN_CLS}>{formatMetricMemory(memory)}</span>
    </div>
  )
}
