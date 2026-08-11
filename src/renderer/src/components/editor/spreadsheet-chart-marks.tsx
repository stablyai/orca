import React from 'react'
import {
  buildSlicePath,
  clampToScale,
  describePoint,
  formatTick,
  resolveSeriesColor,
  CHART_AREA_FILL_OPACITY,
  CHART_LINE_WIDTH,
  CHART_MARKER_RADIUS,
  CHART_MAX_BAR_THICKNESS,
  CHART_SURFACE_GAP
} from './spreadsheet-chart-geometry'
import { projectOntoScale, type SpreadsheetChartScale } from './spreadsheet-chart-scale'
import type { XlsxChart } from './xlsx-chart'

export function CartesianPlot({
  chart,
  scale,
  left,
  top,
  width,
  height
}: {
  chart: XlsxChart
  scale: SpreadsheetChartScale
  left: number
  top: number
  width: number
  height: number
}): React.JSX.Element {
  const isHorizontal = chart.kind === 'bar'
  const categoryCount = Math.max(
    chart.categories.length,
    ...chart.series.map((series) => series.values.length),
    1
  )
  const valueAt = (fraction: number): number =>
    isHorizontal ? left + fraction * width : top + height - fraction * height
  const bandSize = (isHorizontal ? height : width) / categoryCount

  return (
    <>
      {/* Gridlines and axis ticks stay recessive: hairline, solid, one step off the
      surface, and the labels wear muted ink rather than any series colour. */}
      {scale.ticks.map((tick) => {
        const position = valueAt(projectOntoScale(tick, scale))
        return (
          <g key={tick}>
            <line
              x1={isHorizontal ? position : left}
              y1={isHorizontal ? top : position}
              x2={isHorizontal ? position : left + width}
              y2={isHorizontal ? top + height : position}
              className="stroke-spreadsheet-gridline"
              strokeWidth={1}
            />
            <text
              x={isHorizontal ? position : left - 6}
              y={isHorizontal ? top + height + 12 : position + 3}
              textAnchor={isHorizontal ? 'middle' : 'end'}
              className="fill-spreadsheet-header-foreground text-[9px]"
            >
              {formatTick(tick)}
            </text>
          </g>
        )
      })}
      {chart.kind === 'column' || chart.kind === 'bar' ? (
        <BarMarks
          chart={chart}
          scale={scale}
          left={left}
          top={top}
          width={width}
          height={height}
          bandSize={bandSize}
          isHorizontal={isHorizontal}
        />
      ) : (
        <PointMarks
          chart={chart}
          scale={scale}
          left={left}
          top={top}
          width={width}
          height={height}
          categoryCount={categoryCount}
          filled={chart.kind === 'area'}
          showLine={chart.kind !== 'scatter'}
        />
      )}
      {!isHorizontal &&
        chart.categories.map((category, index) => (
          <text
            key={index}
            x={left + bandSize * (index + 0.5)}
            y={top + height + 13}
            textAnchor="middle"
            className="fill-spreadsheet-header-foreground text-[9px]"
          >
            {category}
          </text>
        ))}
    </>
  )
}

function BarMarks({
  chart,
  scale,
  left,
  top,
  width,
  height,
  bandSize,
  isHorizontal
}: {
  chart: XlsxChart
  scale: SpreadsheetChartScale
  left: number
  top: number
  width: number
  height: number
  bandSize: number
  isHorizontal: boolean
}): React.JSX.Element {
  const seriesCount = chart.series.length
  // Why: cap the thickness and leave the band's remainder as air rather than
  // filling the slot, and keep a surface gap between neighbours.
  const rawThickness =
    (bandSize - CHART_SURFACE_GAP * 2) / Math.max(seriesCount, 1) - CHART_SURFACE_GAP
  const thickness = Math.max(1, Math.min(CHART_MAX_BAR_THICKNESS, rawThickness))
  const baseline = isHorizontal
    ? left + projectOntoScale(clampToScale(0, scale), scale) * width
    : top + height - projectOntoScale(clampToScale(0, scale), scale) * height

  return (
    <>
      {chart.series.map((series, seriesIndex) =>
        series.values.map((value, categoryIndex) => {
          if (value === null) {
            return null
          }
          const valuePosition = isHorizontal
            ? left + projectOntoScale(value, scale) * width
            : top + height - projectOntoScale(value, scale) * height
          const bandStart =
            (isHorizontal ? top : left) +
            bandSize * categoryIndex +
            CHART_SURFACE_GAP +
            seriesIndex * (thickness + CHART_SURFACE_GAP)
          const length = Math.abs(valuePosition - baseline)
          return (
            <rect
              key={`${seriesIndex}:${categoryIndex}`}
              x={isHorizontal ? Math.min(baseline, valuePosition) : bandStart}
              y={isHorizontal ? bandStart : Math.min(baseline, valuePosition)}
              width={isHorizontal ? length : thickness}
              height={isHorizontal ? thickness : length}
              // Why: a 4px rounded data-end reads as the end of the mark; the
              // baseline edge stays square, which rx alone cannot express, so the
              // radius is kept small enough not to round the baseline visibly.
              rx={Math.min(4, thickness / 2)}
              fill={resolveSeriesColor(series, seriesIndex)}
            >
              <title>{describePoint(chart, series, seriesIndex, categoryIndex, value)}</title>
            </rect>
          )
        })
      )}
    </>
  )
}

function PointMarks({
  chart,
  scale,
  left,
  top,
  width,
  height,
  categoryCount,
  filled,
  showLine
}: {
  chart: XlsxChart
  scale: SpreadsheetChartScale
  left: number
  top: number
  width: number
  height: number
  categoryCount: number
  filled: boolean
  showLine: boolean
}): React.JSX.Element {
  const stepWidth = categoryCount > 1 ? width / (categoryCount - 1) : 0
  const pointAt = (value: number, index: number): { x: number; y: number } => ({
    x: categoryCount > 1 ? left + stepWidth * index : left + width / 2,
    y: top + height - projectOntoScale(value, scale) * height
  })

  return (
    <>
      {chart.series.map((series, seriesIndex) => {
        const color = resolveSeriesColor(series, seriesIndex)
        const points = series.values
          .map((value, index) =>
            value === null ? null : { ...pointAt(value, index), value, index }
          )
          .filter(
            (point): point is { x: number; y: number; value: number; index: number } =>
              point !== null
          )
        if (points.length === 0) {
          return null
        }
        const path = points.map((point) => `${point.x},${point.y}`).join(' ')
        const baselineY = top + height - projectOntoScale(clampToScale(0, scale), scale) * height
        const gradientId = `spreadsheet-chart-gradient-${seriesIndex}`
        const gradient = sparklineGradient(chart, seriesIndex)
        return (
          <g key={seriesIndex}>
            {filled &&
              gradient !== undefined && (
                // Why: the file's own gradient, drawn top to bottom as its angle asks.
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    {gradient.map((stop, stopIndex) => (
                      <stop
                        key={stopIndex}
                        offset={`${stop.position * 100}%`}
                        stopColor={stop.color}
                      />
                    ))}
                  </linearGradient>
                </defs>
              )}
            {filled && (
              <polygon
                points={`${points[0]!.x},${baselineY} ${path} ${points.at(-1)!.x},${baselineY}`}
                fill={gradient === undefined ? color : `url(#${gradientId})`}
                fillOpacity={gradient === undefined ? CHART_AREA_FILL_OPACITY : 1}
              />
            )}
            {showLine && (
              <polyline
                points={path}
                fill="none"
                stroke={color}
                strokeWidth={CHART_LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {points.map((point) => (
              <circle
                key={point.index}
                cx={point.x}
                cy={point.y}
                r={CHART_MARKER_RADIUS}
                fill={color}
                // Why: a surface ring keeps a marker legible where it crosses its
                // own line or another series.
                className="stroke-spreadsheet-surface"
                strokeWidth={CHART_SURFACE_GAP}
              >
                <title>{describePoint(chart, series, seriesIndex, point.index, point.value)}</title>
              </circle>
            ))}
          </g>
        )
      })}
    </>
  )
}

function sparklineGradient(
  chart: XlsxChart,
  seriesIndex: number
): XlsxChart['series'][number]['gradient'] {
  return chart.series[seriesIndex]?.gradient
}

export function CircularPlot({
  chart,
  centerX,
  centerY,
  radius,
  innerRadiusRatio
}: {
  chart: XlsxChart
  centerX: number
  centerY: number
  radius: number
  innerRadiusRatio: number
}): React.JSX.Element | null {
  // Why: a pie plots one series across its categories, so each slice takes the
  // theme colour of its own index rather than the series colour.
  const values = (chart.series[0]?.values ?? []).map((value) =>
    value === null ? 0 : Math.abs(value)
  )
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total === 0) {
    return null
  }

  let startAngle = -Math.PI / 2
  return (
    <>
      {values.map((value, index) => {
        const sweep = (value / total) * Math.PI * 2
        const endAngle = startAngle + sweep
        const path = buildSlicePath({
          centerX,
          centerY,
          radius,
          innerRadius: radius * innerRadiusRatio,
          startAngle,
          endAngle
        })
        startAngle = endAngle
        return (
          <path
            key={index}
            d={path}
            fill={resolveSeriesColor(chart.series[0], index)}
            // Why: the surface stroke is the 2px gap that separates touching
            // slices — not a border drawn to outline the mark.
            className="stroke-spreadsheet-surface"
            strokeWidth={CHART_SURFACE_GAP}
          >
            <title>{`${chart.categories[index] ?? index + 1}: ${formatTick(value)}`}</title>
          </path>
        )
      })}
    </>
  )
}
