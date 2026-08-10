import type { SpreadsheetChartScale } from './spreadsheet-chart-scale'
import type { XlsxChart, XlsxChartSeries } from './xlsx-chart'

/** Layout and mark constants shared by the chart shell and its marks. */
export const CHART_TITLE_HEIGHT = 22
export const CHART_LEGEND_HEIGHT = 20
export const CHART_AXIS_LABEL_WIDTH = 44
export const CHART_CATEGORY_LABEL_HEIGHT = 18
export const CHART_PLOT_PADDING = 8
export const CHART_MAX_BAR_THICKNESS = 24
export const CHART_SURFACE_GAP = 2
export const CHART_LINE_WIDTH = 2
export const CHART_MARKER_RADIUS = 4
export const CHART_AREA_FILL_OPACITY = 0.1
// Why: below this the plot is unreadable and the labels collide, so the frame says
// what it is instead of drawing an illegible thumbnail.
export const CHART_MIN_PLOT_WIDTH = 120
export const CHART_MIN_PLOT_HEIGHT = 80

// Why: Excel walks its theme accents when a series sets no colour, so the fallback
// reproduces that rather than picking a palette of our own. The accents are read
// from the workbook's theme where available; these are the Office defaults used
// only when the file ships no theme part at all.
export const DEFAULT_SERIES_COLORS = [
  '#4472c4',
  '#ed7d31',
  '#a5a5a5',
  '#ffc000',
  '#5b9bd5',
  '#70ad47'
] as const

export function resolveSeriesColor(series: XlsxChartSeries | undefined, index: number): string {
  return series?.color ?? DEFAULT_SERIES_COLORS[index % DEFAULT_SERIES_COLORS.length]!
}

export function clampToScale(value: number, scale: SpreadsheetChartScale): number {
  return Math.min(scale.max, Math.max(scale.min, value))
}

export function formatTick(value: number): string {
  return Math.abs(value) >= 1000 ? value.toLocaleString() : String(value)
}

export function describePoint(
  chart: XlsxChart,
  series: XlsxChartSeries,
  seriesIndex: number,
  categoryIndex: number,
  value: number
): string {
  const seriesName = series.name ?? `${seriesIndex + 1}`
  const category = chart.categories[categoryIndex] ?? `${categoryIndex + 1}`
  return `${seriesName} · ${category}: ${formatTick(value)}`
}

export function buildChartLabel(chart: XlsxChart): string {
  const seriesNames = chart.series.map((series, index) => series.name ?? `${index + 1}`).join(', ')
  return chart.title === undefined ? seriesNames : `${chart.title}: ${seriesNames}`
}

export function buildSlicePath({
  centerX,
  centerY,
  radius,
  innerRadius,
  startAngle,
  endAngle
}: {
  centerX: number
  centerY: number
  radius: number
  innerRadius: number
  startAngle: number
  endAngle: number
}): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
  const outerStart = polarPoint(centerX, centerY, radius, startAngle)
  const outerEnd = polarPoint(centerX, centerY, radius, endAngle)
  if (innerRadius <= 0) {
    return `M ${centerX} ${centerY} L ${outerStart.x} ${outerStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} Z`
  }
  const innerEnd = polarPoint(centerX, centerY, innerRadius, endAngle)
  const innerStart = polarPoint(centerX, centerY, innerRadius, startAngle)
  return `M ${outerStart.x} ${outerStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y} Z`
}

export function polarPoint(
  centerX: number,
  centerY: number,
  radius: number,
  angle: number
): { x: number; y: number } {
  return { x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) }
}
