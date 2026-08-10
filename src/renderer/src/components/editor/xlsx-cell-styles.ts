import { pickReadableCellTextColor } from './spreadsheet-cell-contrast'
import { parseXlsxCellFormats } from './xlsx-cell-formats'
import { resolveXlsxColor } from './xlsx-color'
import { parseXlsxThemePalette, type XlsxThemePalette } from './xlsx-theme-palette'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/** The visual styling the viewer renders for one cell. */
export type XlsxCellStyle = {
  backgroundColor?: string
  textColor?: string
  bold?: boolean
  /** Horizontal alignment the author set, which wins over inferring it. */
  horizontalAlignment?: 'left' | 'right' | 'center'
  wrapText?: boolean
}

export type XlsxCellStyles = {
  /** False when no cell format carries a fill, font colour or bold. */
  hasVisualStyles: boolean
  /**
   * The style for a cell's `s` index, or undefined when it has none. Returns the
   * same object for the same index, so a sheet stores references rather than one
   * object per cell.
   */
  getStyle(styleIndex: number | undefined): XlsxCellStyle | undefined
}

const EMPTY_CELL_STYLES: XlsxCellStyles = {
  hasVisualStyles: false,
  getStyle: () => undefined
}

// Why: only a solid pattern is a flat background. `none` is no fill, and the
// hatch patterns (gray125 and friends) paint a texture — showing them as a solid
// block would invent a colour the sheet does not have, so they are skipped.
const SOLID_PATTERN_TYPE = 'solid'

export function parseXlsxCellStyles(stylesXml: string, themeXml: string): XlsxCellStyles {
  if (stylesXml === '') {
    return EMPTY_CELL_STYLES
  }

  const themePalette = parseXlsxThemePalette(themeXml)
  const fills = parseFills(stylesXml, themePalette)
  const fonts = parseFonts(stylesXml, themePalette)
  const cellFormats = parseXlsxCellFormats(stylesXml)
  const styleCache = new Map<number, XlsxCellStyle | undefined>()

  const buildStyle = (styleIndex: number): XlsxCellStyle | undefined => {
    const cellFormat = cellFormats[styleIndex]
    if (cellFormat === undefined) {
      return undefined
    }
    const backgroundColor = fills[cellFormat.fillId]
    const font = fonts[cellFormat.fontId]
    const style: XlsxCellStyle = {}
    if (backgroundColor !== undefined) {
      style.backgroundColor = backgroundColor
      style.textColor = pickReadableCellTextColor(backgroundColor, font?.color)
    }
    if (font?.bold === true) {
      style.bold = true
    }
    const horizontalAlignment = normalizeHorizontalAlignment(cellFormat.horizontalAlignment)
    if (horizontalAlignment !== undefined) {
      style.horizontalAlignment = horizontalAlignment
    }
    if (cellFormat.wrapText === true) {
      style.wrapText = true
    }
    return Object.keys(style).length === 0 ? undefined : style
  }

  const hasVisualStyles = cellFormats.some((_, styleIndex) => buildStyle(styleIndex) !== undefined)

  return {
    hasVisualStyles,
    getStyle: (styleIndex) => {
      if (styleIndex === undefined) {
        return undefined
      }
      if (!styleCache.has(styleIndex)) {
        styleCache.set(styleIndex, buildStyle(styleIndex))
      }
      return styleCache.get(styleIndex)
    }
  }
}

// Why: `justify` and `distributed` have no counterpart in a read-only cell, and
// `general` means "infer from the value", which is what the viewer already does.
const HORIZONTAL_ALIGNMENTS: Record<string, 'left' | 'right' | 'center'> = {
  left: 'left',
  right: 'right',
  center: 'center',
  centerContinuous: 'center'
}

function normalizeHorizontalAlignment(
  horizontal: string | undefined
): 'left' | 'right' | 'center' | undefined {
  return horizontal === undefined ? undefined : HORIZONTAL_ALIGNMENTS[horizontal]
}

/** Fill colour per `<fills>` index, or undefined for an unfilled entry. */
function parseFills(stylesXml: string, themePalette: XlsxThemePalette): (string | undefined)[] {
  const fills: (string | undefined)[] = []

  forEachXlsxXmlElement(stylesXml, 'fills', (fillsBlock) => {
    forEachXlsxXmlElement(fillsBlock.inner, 'fill', (fill) => {
      fills.push(readSolidFillColor(fill.inner, themePalette))
    })
    return false
  })

  return fills
}

function readSolidFillColor(fillXml: string, themePalette: XlsxThemePalette): string | undefined {
  let color: string | undefined
  forEachXlsxXmlElement(fillXml, 'patternFill', (patternFill) => {
    if (patternFill.attributes.patternType !== SOLID_PATTERN_TYPE) {
      return false
    }
    // Why: for a solid pattern the *foreground* colour is the visible one, and
    // Excel routinely leaves an unrelated `bgColor` behind in the same element.
    forEachXlsxXmlElement(patternFill.inner, 'fgColor', (fgColor) => {
      color = resolveXlsxColor(fgColor.attributes, themePalette) ?? undefined
      return false
    })
    return false
  })
  return color
}

type XlsxFont = { color?: string; bold?: boolean }

function parseFonts(stylesXml: string, themePalette: XlsxThemePalette): XlsxFont[] {
  const fonts: XlsxFont[] = []

  forEachXlsxXmlElement(stylesXml, 'fonts', (fontsBlock) => {
    forEachXlsxXmlElement(fontsBlock.inner, 'font', (font) => {
      fonts.push({
        color: readFontColor(font.inner, themePalette),
        bold: hasBoldElement(font.inner)
      })
    })
    return false
  })

  return fonts
}

function readFontColor(fontXml: string, themePalette: XlsxThemePalette): string | undefined {
  let color: string | undefined
  forEachXlsxXmlElement(fontXml, 'color', (element) => {
    color = resolveXlsxColor(element.attributes, themePalette) ?? undefined
    return false
  })
  return color
}

function hasBoldElement(fontXml: string): boolean {
  let bold = false
  forEachXlsxXmlElement(fontXml, 'b', (element) => {
    // Why: `<b val="0"/>` explicitly turns bold off, which a named cell style
    // does when it overrides an inherited bold.
    bold = element.attributes.val !== '0' && element.attributes.val !== 'false'
    return false
  })
  return bold
}
