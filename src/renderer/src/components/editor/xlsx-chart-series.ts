import { resolveXlsxColor, resolveXlsxSchemeColor } from './xlsx-color'
import type { XlsxChartGradientStop, XlsxChartSeries } from './xlsx-chart'
import {
  readAttributeValue,
  readElementInner,
  readFirstValue,
  readNumericCache,
  readStringCache
} from './xlsx-chart-xml'
import type { XlsxThemePalette } from './xlsx-theme-palette'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'

// Why: how many series one chart may carry. A chart with more is a rendering cost
// with no readable payoff at the size a spreadsheet anchors it.
const MAX_CHART_SERIES = 24

export function readSeries(
  plotXml: string,
  themePalette: XlsxThemePalette
): Omit<XlsxChartSeries, 'kind'>[] {
  const series: Omit<XlsxChartSeries, 'kind'>[] = []

  forEachXlsxXmlElement(plotXml, 'c:ser', (element) => {
    if (series.length >= MAX_CHART_SERIES) {
      return false
    }
    const shapeXml = readElementInner(element.inner, 'c:spPr')
    series.push({
      name: readSeriesName(element.inner),
      color: readSeriesColor(element.inner, themePalette),
      gradient: shapeXml === null ? undefined : readGradientStops(shapeXml, themePalette),
      // Why: a scatter series keeps its values in `c:yVal`, with `c:xVal` for the
      // positions; every other plot uses `c:val`. Reading only `c:val` left an
      // overlaid target line with a name and a colour but no points.
      values: readNumericCache(
        readElementInner(element.inner, 'c:val') ?? readElementInner(element.inner, 'c:yVal') ?? ''
      ),
      positions: readSeriesPositions(element.inner),
      showsMarkers: readSeriesShowsMarkers(element.inner)
    })
    return true
  })

  return series
}

// Why: a series that sets `c:symbol` to `none` is drawn as a bare line, which is
// how an author writes a target line. Absent markers default to shown, since that
// is what a line or scatter series without the element gets from Excel.
export function readSeriesShowsMarkers(seriesXml: string): boolean | undefined {
  const markerXml = readElementInner(seriesXml, 'c:marker')
  if (markerXml === null) {
    return undefined
  }
  return readAttributeValue(markerXml, 'c:symbol') !== 'none'
}

// Why: only a scatter series carries x positions. Returning undefined for the
// rest keeps them positioned by category index, which is what their axis means.
export function readSeriesPositions(seriesXml: string): (number | null)[] | undefined {
  const positionsXml = readElementInner(seriesXml, 'c:xVal')
  if (positionsXml === null) {
    return undefined
  }
  const positions = readNumericCache(positionsXml)
  return positions.length === 0 ? undefined : positions
}

export function readSeriesName(seriesXml: string): string | undefined {
  const nameXml = readElementInner(seriesXml, 'c:tx')
  if (nameXml === null) {
    return undefined
  }
  const cached = readStringCache(nameXml)
  return cached[0] ?? readFirstValue(nameXml) ?? undefined
}

// Why: an area series usually carries a gradient rather than a flat colour, and it
// is the chart's dominant visual — dropping it leaves the plot looking unfilled.
export function readGradientStops(
  shapeXml: string,
  themePalette: XlsxThemePalette
): XlsxChartGradientStop[] | undefined {
  const gradientXml = readElementInner(shapeXml, 'a:gradFill')
  if (gradientXml === null) {
    return undefined
  }

  const stops: XlsxChartGradientStop[] = []
  forEachXlsxXmlElement(gradientXml, 'a:gs', (stop) => {
    const position = Number.parseInt(stop.attributes.pos ?? '', 10)
    const color = readShapeColor(stop.inner, themePalette)
    if (Number.isFinite(position) && color !== undefined) {
      // Why: positions are in thousandths of a percent.
      stops.push({ position: Math.min(1, Math.max(0, position / 100_000)), color })
    }
  })

  return stops.length >= 2 ? stops.sort((a, b) => a.position - b.position) : undefined
}

export function readShapeColor(xml: string, themePalette: XlsxThemePalette): string | undefined {
  let color: string | undefined
  forEachXlsxXmlElement(xml, 'a:srgbClr', (element) => {
    color = resolveXlsxColor({ rgb: element.attributes.val }, themePalette) ?? undefined
    return false
  })
  if (color !== undefined) {
    return color
  }
  forEachXlsxXmlElement(xml, 'a:schemeClr', (element) => {
    const scheme = element.attributes.val
    color =
      scheme === undefined ? undefined : (resolveXlsxSchemeColor(scheme, themePalette) ?? undefined)
    return false
  })
  return color
}

// Why: a series may set its colour explicitly or leave it to the theme. When it
// leaves it, Excel walks accent1..6 — reproducing that is faithful to the file,
// not a palette choice of ours.
export function readSeriesColor(
  seriesXml: string,
  themePalette: XlsxThemePalette
): string | undefined {
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
