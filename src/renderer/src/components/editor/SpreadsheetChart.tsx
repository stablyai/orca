import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import {
  buildChartLabel,
  resolveSeriesColor,
  CHART_AXIS_LABEL_WIDTH,
  CHART_CATEGORY_LABEL_HEIGHT,
  CHART_LEGEND_HEIGHT,
  CHART_MIN_PLOT_HEIGHT,
  CHART_MIN_PLOT_WIDTH,
  CHART_PLOT_PADDING,
  CHART_TITLE_HEIGHT
} from './spreadsheet-chart-geometry'
import { CartesianPlot, CircularPlot } from './spreadsheet-chart-marks'
import { buildSpreadsheetChartScale } from './spreadsheet-chart-scale'
import type { XlsxChart } from './xlsx-chart'

type SpreadsheetChartProps = {
  chart: XlsxChart
  width: number
  height: number
}

/**
 * Draws a workbook's own chart as inline SVG.
 *
 * Scope of the design decisions here: the *form* and the *series colours* come
 * from the file, so neither is ours to choose — recolouring an author's series to
 * satisfy a palette would misreport the document, the same way reformatting their
 * numbers would. What the file does not specify is ours, and follows the project's
 * visualization guidance: hairline recessive gridlines, 2px lines with round caps,
 * markers of at least 8px carrying a surface ring, a 2px surface gap between
 * touching marks, a legend whenever there are two or more series (never for one,
 * where the title already names it), no value printed on every point, and text in
 * text tokens rather than the series colour. Every mark carries a `<title>`, so
 * identity never depends on colour alone.
 */

export function SpreadsheetChart({
  chart,
  width,
  height
}: SpreadsheetChartProps): React.JSX.Element {
  const allValues = useMemo(() => chart.series.flatMap((series) => series.values), [chart.series])
  // Why: Excel starts a column or bar at zero, but auto-scales a line or area to
  // its own data — a weight chart between 172 and 178 is drawn over that range,
  // not from zero, and forcing zero flattens it into a straight line.
  // Any bar series anchors the axis, even when it is overlaid on a line plot.
  const usesBaseline = chart.series.some((series) => {
    const kind = series.kind ?? chart.kind
    return kind === 'column' || kind === 'bar'
  })
  const scale = useMemo(
    () => buildSpreadsheetChartScale(allValues, { includeZero: usesBaseline }),
    [allValues, usesBaseline]
  )

  const hasTitle = chart.title !== undefined
  const showLegend = chart.showLegend && chart.series.length >= 2
  const isCircular = chart.kind === 'pie' || chart.kind === 'doughnut'
  const plotTop = (hasTitle ? CHART_TITLE_HEIGHT : 0) + CHART_PLOT_PADDING
  const plotBottom =
    height - (showLegend ? CHART_LEGEND_HEIGHT : 0) - (isCircular ? 0 : CHART_CATEGORY_LABEL_HEIGHT)
  const plotLeft = isCircular ? CHART_PLOT_PADDING : CHART_AXIS_LABEL_WIDTH
  const plotRight = width - CHART_PLOT_PADDING
  const plotWidth = plotRight - plotLeft
  const plotHeight = plotBottom - plotTop

  if (
    chart.kind === null ||
    plotWidth < CHART_MIN_PLOT_WIDTH ||
    plotHeight < CHART_MIN_PLOT_HEIGHT
  ) {
    return <ChartFrame chart={chart} width={width} height={height} />
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={buildChartLabel(chart)}
      className="overflow-visible"
    >
      {hasTitle && (
        <text
          x={width / 2}
          y={CHART_TITLE_HEIGHT - 6}
          textAnchor="middle"
          className="fill-spreadsheet-foreground text-[11px] font-medium"
        >
          {chart.title}
        </text>
      )}
      {isCircular ? (
        <CircularPlot
          chart={chart}
          centerX={plotLeft + plotWidth / 2}
          centerY={plotTop + plotHeight / 2}
          radius={Math.min(plotWidth, plotHeight) / 2}
          innerRadiusRatio={chart.kind === 'doughnut' ? 0.55 : 0}
        />
      ) : (
        <CartesianPlot
          chart={chart}
          scale={scale}
          left={plotLeft}
          top={plotTop}
          width={plotWidth}
          height={plotHeight}
        />
      )}
      {showLegend && <Legend chart={chart} y={height - 6} width={width} />}
    </svg>
  )
}

function ChartFrame({
  chart,
  width,
  height
}: {
  chart: XlsxChart
  width: number
  height: number
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded border border-spreadsheet-gridline-strong bg-spreadsheet-header px-2 text-center"
      style={{ width, height }}
    >
      <span className="text-[11px] font-medium text-spreadsheet-foreground">
        {chart.title ?? translate('auto.components.editor.SpreadsheetChart.3a8a24e9d0', 'Chart')}
      </span>
      <span className="text-[10px] text-spreadsheet-header-foreground">
        {chart.kind === null
          ? translate(
              'auto.components.editor.SpreadsheetChart.bc7b6e940e',
              'This chart type is not rendered'
            )
          : translate(
              'auto.components.editor.SpreadsheetChart.255f7ec4a9',
              'Too small to plot at this zoom'
            )}
      </span>
    </div>
  )
}

function Legend({
  chart,
  y,
  width
}: {
  chart: XlsxChart
  y: number
  width: number
}): React.JSX.Element {
  const entries =
    chart.kind === 'pie' || chart.kind === 'doughnut'
      ? chart.categories
      : chart.series.map((series, index) => series.name ?? `${index + 1}`)
  const step = width / Math.max(entries.length, 1)

  return (
    <>
      {entries.map((entry, index) => (
        <g key={index}>
          <rect
            x={step * index + 8}
            y={y - 7}
            width={8}
            height={8}
            rx={2}
            fill={resolveSeriesColor(
              chart.kind === 'pie' || chart.kind === 'doughnut'
                ? chart.series[0]
                : chart.series[index],
              index
            )}
          />
          <text
            x={step * index + 20}
            y={y}
            className="fill-spreadsheet-header-foreground text-[9px]"
          >
            {entry}
          </text>
        </g>
      ))}
    </>
  )
}
