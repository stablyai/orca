import { readSeries } from './xlsx-chart-series'
import {
  countElements,
  hasElement,
  readAttributeValue,
  readElementInner,
  readElementText,
  readStringCache
} from './xlsx-chart-xml'
import { formatXlsxDate } from './xlsx-date-format'
import { isXlsxDateFormatCode } from './xlsx-number-formats'
import type { XlsxThemePalette } from './xlsx-theme-palette'
import { decodeXlsxXmlText, forEachXlsxXmlElement } from './xlsx-xml-elements'

/** The plot types the viewer draws. */
export type XlsxChartKind = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter'

/** A gradient stop, at a fraction of the way along the fill. */
export type XlsxChartGradientStop = { position: number; color: string }

export type XlsxChartSeries = {
  /**
   * The plot this series belongs to. Excel overlays plots of different types in
   * one chart — a target line over an area, most commonly — so the mark type is
   * a property of the series, not of the chart. Absent means the chart's own kind.
   */
  kind?: XlsxChartKind
  name?: string
  color?: string
  /**
   * Stops of a gradient fill, when the series declares one. Excel uses these for
   * area charts far more often than a flat colour.
   */
  gradient?: XlsxChartGradientStop[]
  /** Values by category index; null for a gap the author left blank. */
  values: (number | null)[]
  /**
   * X positions from a scatter series' `c:xVal`, on the same axis as the other
   * series. A target line spans the whole plot with two points, so it can only be
   * placed by its values and not by their index.
   */
  positions?: (number | null)[]
  /**
   * Whether the series joins its points. A scatter plot decides this with
   * `c:scatterStyle`: `lineMarker` and its siblings draw a line, plain `marker`
   * draws points only.
   */
  showsLine?: boolean
  /** False when the series sets `c:symbol` to `none`, as a plain line does. */
  showsMarkers?: boolean
}

export type XlsxChart = {
  /**
   * The first plot's type, which sets the axis orientation and the circular
   * layouts. Null when the part parsed but declares a plot the viewer cannot
   * draw. Individual series carry their own kind.
   */
  kind: XlsxChartKind | null
  /** The plot element found, so an unsupported chart can say what it is. */
  declaredType?: string
  title?: string
  categories: string[]
  series: XlsxChartSeries[]
  showLegend: boolean
  /** True when the chart plots a second value axis, which the viewer flattens. */
  hasSecondaryAxis: boolean
}

// Why: the plot element names the type. `barDir` then separates a column chart
// from a horizontal bar chart, which are the same element in the format.
const PLOT_ELEMENTS: Record<string, XlsxChartKind> = {
  'c:barChart': 'column',
  'c:bar3DChart': 'column',
  'c:lineChart': 'line',
  'c:line3DChart': 'line',
  'c:areaChart': 'area',
  'c:area3DChart': 'area',
  'c:pieChart': 'pie',
  'c:pie3DChart': 'pie',
  'c:doughnutChart': 'doughnut',
  'c:scatterChart': 'scatter'
}
// Why: named so an unsupported chart can report what it actually is rather than
// rendering an empty frame the reader cannot explain.
const UNSUPPORTED_PLOT_ELEMENTS = [
  'c:radarChart',
  'c:bubbleChart',
  'c:stockChart',
  'c:surfaceChart',
  'c:surface3DChart',
  'c:ofPieChart'
] as const
const MAX_CHART_SERIES = 24

export type ParseXlsxChartOptions = {
  /** Locale for month and weekday names on a date axis. */
  locale?: string
}

export function parseXlsxChart(
  chartXml: string,
  themePalette: XlsxThemePalette,
  { locale = 'en-US' }: ParseXlsxChartOptions = {}
): XlsxChart | null {
  let plotAreaXml: string | null = null
  forEachXlsxXmlElement(chartXml, 'c:plotArea', (element) => {
    plotAreaXml = element.inner
    return false
  })
  if (plotAreaXml === null) {
    return null
  }

  const plots = findPlots(plotAreaXml)
  const primaryPlot = plots[0] ?? null
  const series: XlsxChartSeries[] = []
  for (const plot of plots) {
    if (plot.kind === null) {
      continue
    }
    // Why: the scatter subtype lives on the plot, not the series, and decides
    // whether its series are lines or bare points. Only a scatter plot needs to
    // say so — every other kind already implies its own answer.
    const showsLine =
      plot.kind === 'scatter'
        ? readAttributeValue(plot.xml, 'c:scatterStyle') !== 'marker'
        : undefined
    for (const plotSeries of readSeries(plot.xml, themePalette)) {
      if (series.length >= MAX_CHART_SERIES) {
        break
      }
      series.push({ ...plotSeries, kind: plot.kind, showsLine })
    }
  }
  // Why: categories are declared per plot, and an overlaid scatter plot often
  // omits them. The first plot that names them speaks for the chart.
  const categoriesPlot = plots.find((plot) => readCategories(plot.xml, locale).length > 0)
  return {
    kind: primaryPlot?.kind ?? null,
    declaredType: primaryPlot?.element,
    title: readChartTitle(chartXml),
    categories: categoriesPlot === undefined ? [] : readCategories(categoriesPlot.xml, locale),
    series,
    showLegend: hasElement(chartXml, 'c:legend'),
    // Why: Excel allows a second value axis; the viewer plots everything on one
    // scale rather than drawing two, so this is surfaced instead of hidden.
    hasSecondaryAxis: countElements(plotAreaXml, 'c:valAx') > 1
  }
}

type XlsxChartPlot = { element: string; kind: XlsxChartKind | null; xml: string }

/**
 * Every plot in the plot area, ordered as the document lists them.
 *
 * Why all of them: a chart may overlay plots of different types — Excel draws a
 * target line as a `scatterChart` on top of an `areaChart` — and reading only the
 * first silently dropped the line the author added.
 */
function findPlots(plotAreaXml: string): XlsxChartPlot[] {
  const found: (XlsxChartPlot & { position: number })[] = []

  const consider = (element: string, kind: XlsxChartKind | null): void => {
    const xml = readElementInner(plotAreaXml, element)
    if (xml === null) {
      return
    }
    found.push({
      element,
      kind: kind === 'column' && readAttributeValue(xml, 'c:barDir') === 'bar' ? 'bar' : kind,
      xml,
      position: plotAreaXml.indexOf(`<${element}`)
    })
  }

  for (const [element, kind] of Object.entries(PLOT_ELEMENTS)) {
    consider(element, kind)
  }
  for (const element of UNSUPPORTED_PLOT_ELEMENTS) {
    consider(element, null)
  }

  // Why: the document's own order decides which plot is the primary one and the
  // painting order of the overlays, so the lookup order above must not leak out.
  found.sort((left, right) => left.position - right.position)
  return found.map((plot) => ({ element: plot.element, kind: plot.kind, xml: plot.xml }))
}

// Why: categories are shared by every series, so the first series that declares
// them wins — which is how Excel stores them too.
function readCategories(plotXml: string, locale: string): string[] {
  let categories: string[] = []
  forEachXlsxXmlElement(plotXml, 'c:ser', (element) => {
    const categoryXml = readElementInner(element.inner, 'c:cat')
    if (categoryXml === null) {
      return true
    }
    const cached = readCategoryCache(categoryXml, locale)
    if (cached.length > 0) {
      categories = cached
      return false
    }
    return true
  })
  return categories
}

/**
 * Reads the cached category labels.
 *
 * Why the format code matters here: a date axis is cached as serial numbers with
 * the code beside them, so ignoring it puts `46168` on the axis where the file
 * says `26-5`.
 */
function readCategoryCache(categoryXml: string, locale: string): string[] {
  const labels = readStringCache(categoryXml)
  const formatCode = readElementText(categoryXml, 'c:formatCode')
  if (formatCode === undefined || !isXlsxDateFormatCode(formatCode)) {
    return labels
  }
  return labels.map((label) => {
    const serial = Number(label)
    if (!Number.isFinite(serial)) {
      return label
    }
    return formatXlsxDate(serial, formatCode, { use1904DateSystem: false, locale }) ?? label
  })
}

// Why: an auto-generated title is marked deleted rather than removed, so a chart
// that shows no title in Excel must not grow one here.
function readChartTitle(chartXml: string): string | undefined {
  if (readAttributeValue(chartXml, 'c:autoTitleDeleted') === '1') {
    return undefined
  }
  const titleXml = readElementInner(chartXml, 'c:title')
  if (titleXml === null) {
    return undefined
  }
  let title = ''
  forEachXlsxXmlElement(titleXml, 'a:t', (element) => {
    title += decodeXlsxXmlText(element.inner)
  })
  return title === '' ? undefined : title
}
