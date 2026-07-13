import React, { useEffect, useRef, useState } from 'react'
import { formatUsageTokens } from '@/components/stats/usage-overview-model'

export type ChartDims = { width: number; height: number }

const DEFAULT_DIMS: ChartDims = { width: 311, height: 148 }
export const MARGIN_LEFT = 34
export const MARGIN_RIGHT = 8
export const MARGIN_TOP = 6
export const MARGIN_BOTTOM = 16

export function plotWidth(dims: ChartDims): number {
  return dims.width - MARGIN_LEFT - MARGIN_RIGHT
}

export function plotHeight(dims: ChartDims): number {
  return dims.height - MARGIN_TOP - MARGIN_BOTTOM
}

export function valueY(value: number, maxValue: number, dims: ChartDims): number {
  return MARGIN_TOP + plotHeight(dims) - (value / maxValue) * plotHeight(dims)
}

/** Measures the chart's flex container so the SVG fills whatever space the
 *  popover's left column dictates instead of a fixed 148px strip. */
export function useChartDims(): {
  ref: React.RefObject<HTMLDivElement | null>
  dims: ChartDims
} {
  const ref = useRef<HTMLDivElement | null>(null)
  const [dims, setDims] = useState<ChartDims>(DEFAULT_DIMS)

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      setDims({
        width: Math.max(220, Math.floor(rect.width)),
        height: Math.max(132, Math.floor(rect.height))
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, dims }
}

export function YAxis({
  maxValue,
  dims
}: {
  maxValue: number
  dims: ChartDims
}): React.JSX.Element {
  // Why: taller plots earn a denser grid; two lines look sparse past ~200px.
  const fractions = plotHeight(dims) >= 200 ? [0.25, 0.5, 0.75, 1] : [0.5, 1]
  return (
    <>
      {fractions.map((fraction) => {
        const tick = maxValue * fraction
        return (
          <g key={fraction}>
            <line
              x1={MARGIN_LEFT}
              x2={dims.width - MARGIN_RIGHT}
              y1={valueY(tick, maxValue, dims)}
              y2={valueY(tick, maxValue, dims)}
              className="stroke-border/60"
              strokeWidth={1}
            />
            <text
              x={MARGIN_LEFT - 4}
              y={valueY(tick, maxValue, dims) + 2.5}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[8px]"
            >
              {formatUsageTokens(Math.round(tick))}
            </text>
          </g>
        )
      })}
      <line
        x1={MARGIN_LEFT}
        x2={dims.width - MARGIN_RIGHT}
        y1={MARGIN_TOP + plotHeight(dims)}
        y2={MARGIN_TOP + plotHeight(dims)}
        className="stroke-border"
        strokeWidth={1}
      />
    </>
  )
}

function TooltipRow({
  label,
  value,
  emphasized
}: {
  label: string
  value: string
  emphasized?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className={
          emphasized ? 'text-[10px] font-medium text-chart-3' : 'text-[10px] text-muted-foreground'
        }
      >
        {label}
      </span>
      <span
        className={`font-mono text-[10px] ${emphasized ? 'font-semibold' : 'font-medium'} text-foreground`}
      >
        {value}
      </span>
    </div>
  )
}

export function ChartTooltip({
  header,
  rows
}: {
  header: string
  rows: { label: string; value: number; emphasized?: boolean }[]
}): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute right-1 top-1 min-w-[128px] space-y-0.5 rounded-md border border-border/70 bg-popover/95 px-2 py-1.5 shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
      <div className="font-mono text-[10px] font-semibold text-foreground">{header}</div>
      {rows.map((row) => (
        <TooltipRow
          key={row.label}
          label={row.label}
          value={formatUsageTokens(row.value)}
          emphasized={row.emphasized}
        />
      ))}
    </div>
  )
}
