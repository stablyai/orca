import { pickReadableCellTextColor } from './spreadsheet-cell-contrast'
import { resolveXlsxColor } from './xlsx-color'
import type { XlsxCellStyle } from './xlsx-cell-styles'
import type { XlsxThemePalette } from './xlsx-theme-palette'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/**
 * The visual override a `<dxf>` carries, which a conditional formatting rule
 * paints over a cell's own style. Only the properties the rule declares are
 * present, so the cell keeps everything else it already had.
 */
export type XlsxDifferentialFormat = Pick<
  XlsxCellStyle,
  'backgroundColor' | 'textColor' | 'bold' | 'italic'
>

const SOLID_PATTERN_TYPE = 'solid'

/**
 * Parses `<dxfs>` into the overrides a `dxfId` indexes.
 *
 * Why a reader of its own rather than reusing the `<fills>` one: a `<dxf>`
 * inverts the pattern colours. Excel writes the visible fill of a differential
 * format into `bgColor` and leaves `fgColor` as `indexed="64"` (the system
 * default), which is the opposite of a `<fill>` in `<fills>`. Reading `fgColor`
 * here would resolve every highlight to the same non-colour.
 */
export function parseXlsxDifferentialFormats(
  stylesXml: string,
  themePalette: XlsxThemePalette
): XlsxDifferentialFormat[] {
  const differentialFormats: XlsxDifferentialFormat[] = []

  forEachXlsxXmlElement(stylesXml, 'dxfs', (dxfsBlock) => {
    forEachXlsxXmlElement(dxfsBlock.inner, 'dxf', (dxf) => {
      differentialFormats.push(readDifferentialFormat(dxf.inner, themePalette))
    })
    return false
  })

  return differentialFormats
}

function readDifferentialFormat(
  dxfXml: string,
  themePalette: XlsxThemePalette
): XlsxDifferentialFormat {
  const format: XlsxDifferentialFormat = {}
  const backgroundColor = readDifferentialFillColor(dxfXml, themePalette)
  const font = readDifferentialFont(dxfXml, themePalette)

  if (backgroundColor !== undefined) {
    format.backgroundColor = backgroundColor
    format.textColor = pickReadableCellTextColor(backgroundColor, font.color, {
      bold: font.bold
    })
  } else if (font.color !== undefined) {
    format.textColor = font.color
  }
  // Why: a `<dxf>` states the toggles it changes, including the ones it turns off.
  // Carrying an explicit `false` through is what lets a rule clear the bold a
  // cell's own style set; dropping it would leave the cell bold against the file.
  if (font.bold !== undefined) {
    format.bold = font.bold
  }
  if (font.italic !== undefined) {
    format.italic = font.italic
  }
  return format
}

function readDifferentialFillColor(
  dxfXml: string,
  themePalette: XlsxThemePalette
): string | undefined {
  let color: string | undefined
  forEachXlsxXmlElement(dxfXml, 'fill', (fill) => {
    forEachXlsxXmlElement(fill.inner, 'patternFill', (patternFill) => {
      // Why: a `<dxf>` may omit patternType entirely and still mean a solid
      // highlight, but `none` is an explicit "clear the fill".
      const patternType = patternFill.attributes.patternType
      if (patternType !== undefined && patternType !== SOLID_PATTERN_TYPE) {
        return false
      }
      color = readColorElement(patternFill.inner, 'bgColor', themePalette)
      color ??= readColorElement(patternFill.inner, 'fgColor', themePalette)
      return false
    })
    return false
  })
  return color
}

type XlsxDifferentialFont = { color?: string; bold?: boolean; italic?: boolean }

function readDifferentialFont(
  dxfXml: string,
  themePalette: XlsxThemePalette
): XlsxDifferentialFont {
  const font: XlsxDifferentialFont = {}
  forEachXlsxXmlElement(dxfXml, 'font', (element) => {
    font.color = readColorElement(element.inner, 'color', themePalette)
    font.bold = readToggle(element.inner, 'b')
    font.italic = readToggle(element.inner, 'i')
    return false
  })
  return font
}

function readColorElement(
  xml: string,
  tagName: string,
  themePalette: XlsxThemePalette
): string | undefined {
  let color: string | undefined
  forEachXlsxXmlElement(xml, tagName, (element) => {
    color = resolveXlsxColor(element.attributes, themePalette) ?? undefined
    return false
  })
  return color
}

// Why: a `<dxf>` spells out every toggle it touches, including the ones it turns
// off (`<b val="0"/>`), so an explicit off has to read as off and not as present.
function readToggle(xml: string, tagName: string): boolean | undefined {
  let enabled: boolean | undefined
  forEachXlsxXmlElement(xml, tagName, (element) => {
    const value = element.attributes.val
    enabled = value !== '0' && value !== 'false'
    return false
  })
  return enabled
}
