import { resolveXlsxColor, resolveXlsxSchemeColor } from './xlsx-color'
import type { XlsxThemePalette } from './xlsx-theme-palette'
import { decodeXlsxXmlText, forEachXlsxXmlElement } from './xlsx-xml-elements'

/** The plot types the viewer draws. */
export type XlsxChartKind = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter'

export type XlsxChartSeries = {
  name?: string
  color?: string
  /** Values by category index; null for a gap the author left blank. */
  values: (number | null)[]
}

export type XlsxChart = {
  /** Null when the part parsed but declares a plot type the viewer cannot draw. */
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
// Why: a chart with thousands of points is a rendering cost with no readable
// payoff at the size a spreadsheet anchors it.
const MAX_CHART_CATEGORIES = 500
const MAX_CHART_SERIES = 24

export function parseXlsxChart(chartXml: string, themePalette: XlsxThemePalette): XlsxChart | null {
  let plotAreaXml: string | null = null
  forEachXlsxXmlElement(chartXml, 'c:plotArea', (element) => {
    plotAreaXml = element.inner
    return false
  })
  if (plotAreaXml === null) {
    return null
  }

  const plot = findPlot(plotAreaXml)
  const series = plot === null ? [] : readSeries(plot.xml, themePalette)
  return {
    kind: plot?.kind ?? null,
    declaredType: plot?.element,
    title: readChartTitle(chartXml),
    categories: plot === null ? [] : readCategories(plot.xml),
    series,
    showLegend: hasElement(chartXml, 'c:legend'),
    // Why: Excel allows a second value axis; the viewer plots everything on one
    // scale rather than drawing two, so this is surfaced instead of hidden.
    hasSecondaryAxis: countElements(plotAreaXml, 'c:valAx') > 1
  }
}

type XlsxChartPlot = { element: string; kind: XlsxChartKind | null; xml: string }

function findPlot(plotAreaXml: string): XlsxChartPlot | null {
  for (const [element, kind] of Object.entries(PLOT_ELEMENTS)) {
    const xml = readElementInner(plotAreaXml, element)
    if (xml !== null) {
      return {
        element,
        kind: kind === 'column' && readAttributeValue(xml, 'c:barDir') === 'bar' ? 'bar' : kind,
        xml
      }
    }
  }
  for (const element of UNSUPPORTED_PLOT_ELEMENTS) {
    const xml = readElementInner(plotAreaXml, element)
    if (xml !== null) {
      return { element, kind: null, xml }
    }
  }
  return null
}

function readSeries(plotXml: string, themePalette: XlsxThemePalette): XlsxChartSeries[] {
  const series: XlsxChartSeries[] = []

  forEachXlsxXmlElement(plotXml, 'c:ser', (element) => {
    if (series.length >= MAX_CHART_SERIES) {
      return false
    }
    series.push({
      name: readSeriesName(element.inner),
      color: readSeriesColor(element.inner, themePalette),
      values: readNumericCache(readElementInner(element.inner, 'c:val') ?? '')
    })
    return true
  })

  return series
}

function readSeriesName(seriesXml: string): string | undefined {
  const nameXml = readElementInner(seriesXml, 'c:tx')
  if (nameXml === null) {
    return undefined
  }
  const cached = readStringCache(nameXml)
  return cached[0] ?? readFirstValue(nameXml) ?? undefined
}

// Why: a series may set its colour explicitly or leave it to the theme. When it
// leaves it, Excel walks accent1..6 — reproducing that is faithful to the file,
// not a palette choice of ours.
function readSeriesColor(seriesXml: string, themePalette: XlsxThemePalette): string | undefined {
  const shapeXml = readElementInner(seriesXml, 'c:spPr')
  if (shapeXml === null) {
    return undefined
  }
  const fillXml = readElementInner(shapeXml, 'a:solidFill')
  if (fillXml === null) {
    return undefined
  }

  let color: string | undefined
  forEachXlsxXmlElement(fillXml, 'a:srgbClr', (element) => {
    color = resolveXlsxColor({ rgb: element.attributes.val }, themePalette) ?? undefined
    return false
  })
  if (color !== undefined) {
    return color
  }
  forEachXlsxXmlElement(fillXml, 'a:schemeClr', (element) => {
    const scheme = element.attributes.val
    color =
      scheme === undefined ? undefined : (resolveXlsxSchemeColor(scheme, themePalette) ?? undefined)
    return false
  })
  return color
}

// Why: categories are shared by every series, so the first series that declares
// them wins — which is how Excel stores them too.
function readCategories(plotXml: string): string[] {
  let categories: string[] = []
  forEachXlsxXmlElement(plotXml, 'c:ser', (element) => {
    const categoryXml = readElementInner(element.inner, 'c:cat')
    if (categoryXml === null) {
      return true
    }
    const cached = readStringCache(categoryXml)
    if (cached.length > 0) {
      categories = cached
      return false
    }
    return true
  })
  return categories
}

/** Reads `<c:pt idx>` string values, placed by index rather than document order. */
function readStringCache(xml: string): string[] {
  const values: string[] = []
  forEachXlsxXmlElement(xml, 'c:pt', (element) => {
    const index = Number.parseInt(element.attributes.idx ?? '', 10)
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHART_CATEGORIES) {
      return true
    }
    while (values.length < index) {
      values.push('')
    }
    values[index] = readFirstValue(element.inner) ?? ''
    return true
  })
  return values
}

function readNumericCache(xml: string): (number | null)[] {
  const values: (number | null)[] = []
  forEachXlsxXmlElement(xml, 'c:pt', (element) => {
    const index = Number.parseInt(element.attributes.idx ?? '', 10)
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHART_CATEGORIES) {
      return true
    }
    while (values.length < index) {
      values.push(null)
    }
    const parsed = Number(readFirstValue(element.inner) ?? '')
    values[index] = Number.isFinite(parsed) ? parsed : null
    return true
  })
  return values
}

function readFirstValue(xml: string): string | undefined {
  let value: string | undefined
  forEachXlsxXmlElement(xml, 'c:v', (element) => {
    value = decodeXlsxXmlText(element.inner).trim()
    return false
  })
  return value
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

function readElementInner(xml: string, tagName: string): string | null {
  let inner: string | null = null
  forEachXlsxXmlElement(xml, tagName, (element) => {
    inner = element.inner
    return false
  })
  return inner
}

function readAttributeValue(xml: string, tagName: string): string | undefined {
  let value: string | undefined
  forEachXlsxXmlElement(xml, tagName, (element) => {
    value = element.attributes.val
    return false
  })
  return value
}

function hasElement(xml: string, tagName: string): boolean {
  return countElements(xml, tagName) > 0
}

function countElements(xml: string, tagName: string): number {
  let count = 0
  forEachXlsxXmlElement(xml, tagName, () => {
    count += 1
  })
  return count
}
