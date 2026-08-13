import { pickReadableCellTextColor } from './spreadsheet-cell-contrast'
import { resolveXlsxFontFamily } from './xlsx-font-family'
import { parseXlsxCellBorders, type XlsxCellBorders } from './xlsx-cell-borders'
import { parseXlsxCellFormats } from './xlsx-cell-formats'
import { resolveXlsxColor } from './xlsx-color'
import type { XlsxThemePalette } from './xlsx-theme-palette'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/** The visual styling the viewer renders for one cell. */
export type XlsxCellStyle = {
  backgroundColor?: string
  textColor?: string
  bold?: boolean
  /** Horizontal alignment the author set, which wins over inferring it. */
  horizontalAlignment?: 'left' | 'right' | 'center'
  /** Vertical alignment the author set; absent leaves the viewer's default. */
  verticalAlignment?: 'top' | 'middle' | 'bottom'
  /** Indent level the author set, in the spreadsheet's own indent units. */
  indent?: number
  wrapText?: boolean
  italic?: boolean
  /** Font size relative to the workbook default; 1 leaves the app's own size. */
  fontScale?: number
  /** The typeface the cell declares, as a CSS font-family value. */
  fontFamily?: string
  borders?: XlsxCellBorders
}

export type XlsxCellStyles = {
  /** False when no cell format carries a fill, font colour or bold. */
  hasVisualStyles: boolean
  /**
   * The workbook's own default typeface, as a CSS font-family value. A sheet is
   * laid out for it: how much fits in a column and where wrapped text breaks both
   * follow from the face, not just its size.
   */
  defaultFontFamily?: string
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

export function parseXlsxCellStyles(
  stylesXml: string,
  themePalette: XlsxThemePalette
): XlsxCellStyles {
  if (stylesXml === '') {
    return EMPTY_CELL_STYLES
  }

  const fills = parseFills(stylesXml, themePalette)
  const fonts = parseFonts(stylesXml, themePalette)
  const borders = parseXlsxCellBorders(stylesXml, themePalette)
  // Why: font sizes are relative to the workbook's own default, so a sheet keeps
  // its typographic hierarchy while still following the app's base size and zoom.
  const defaultFontSizePt = fonts[0]?.sizePt ?? DEFAULT_FONT_SIZE_PT
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
      style.textColor = pickReadableCellTextColor(backgroundColor, font?.color, {
        sizePt: font?.sizePt,
        bold: font?.bold
      })
    }
    if (font?.bold === true) {
      style.bold = true
    }
    if (font?.italic === true) {
      style.italic = true
    }
    const fontScale = resolveFontScale(font?.sizePt, defaultFontSizePt)
    if (fontScale !== undefined) {
      style.fontScale = fontScale
    }
    // Why: only a cell that departs from the workbook's face needs to say so; the
    // default is set once on the sheet.
    if (font?.name !== undefined && font.name !== fonts[0]?.name) {
      const fontFamily = resolveXlsxFontFamily(font.name)
      if (fontFamily !== undefined) {
        style.fontFamily = fontFamily
      }
    }
    const cellBorders = borders[cellFormat.borderId]
    if (cellBorders !== undefined) {
      style.borders = cellBorders
    }
    const horizontalAlignment = normalizeHorizontalAlignment(cellFormat.horizontalAlignment)
    if (horizontalAlignment !== undefined) {
      style.horizontalAlignment = horizontalAlignment
    }
    const verticalAlignment = VERTICAL_ALIGNMENTS[cellFormat.verticalAlignment ?? '']
    if (verticalAlignment !== undefined) {
      style.verticalAlignment = verticalAlignment
    }
    if (cellFormat.indent !== undefined) {
      style.indent = cellFormat.indent
    }
    if (cellFormat.wrapText === true) {
      style.wrapText = true
    }
    return Object.keys(style).length === 0 ? undefined : style
  }

  const hasVisualStyles = cellFormats.some((_, styleIndex) => buildStyle(styleIndex) !== undefined)

  return {
    hasVisualStyles,
    defaultFontFamily: resolveXlsxFontFamily(fonts[0]?.name),
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

// Why: `justify` and `distributed` stretch a paragraph to the cell's height,
// which a read-only row of text has no counterpart for; both fall back to the
// viewer's default rather than inventing a layout the file did not ask for.
const VERTICAL_ALIGNMENTS: Record<string, 'top' | 'middle' | 'bottom' | undefined> = {
  top: 'top',
  center: 'middle',
  bottom: 'bottom'
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

const DEFAULT_FONT_SIZE_PT = 11
// Why: bound the scale so one absurd font size cannot blow a row out of the
// viewport, and ignore a difference too small to see.
const MIN_FONT_SCALE = 0.6
const MAX_FONT_SCALE = 3

function resolveFontScale(
  sizePt: number | undefined,
  defaultFontSizePt: number
): number | undefined {
  if (sizePt === undefined || defaultFontSizePt <= 0) {
    return undefined
  }
  const scale = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, sizePt / defaultFontSizePt))
  return Math.abs(scale - 1) < 0.05 ? undefined : Number(scale.toFixed(3))
}

type XlsxFont = {
  color?: string
  bold?: boolean
  italic?: boolean
  sizePt?: number
  name?: string
}

function parseFonts(stylesXml: string, themePalette: XlsxThemePalette): XlsxFont[] {
  const fonts: XlsxFont[] = []

  forEachXlsxXmlElement(stylesXml, 'fonts', (fontsBlock) => {
    forEachXlsxXmlElement(fontsBlock.inner, 'font', (font) => {
      fonts.push({
        color: readFontColor(font.inner, themePalette),
        bold: hasToggleElement(font.inner, 'b'),
        italic: hasToggleElement(font.inner, 'i'),
        sizePt: readFontSize(font.inner),
        name: readFontName(font.inner)
      })
    })
    return false
  })

  return fonts
}

function readFontName(fontXml: string): string | undefined {
  let name: string | undefined
  forEachXlsxXmlElement(fontXml, 'name', (element) => {
    name = element.attributes.val
    return false
  })
  return name
}

function readFontColor(fontXml: string, themePalette: XlsxThemePalette): string | undefined {
  let color: string | undefined
  forEachXlsxXmlElement(fontXml, 'color', (element) => {
    color = resolveXlsxColor(element.attributes, themePalette) ?? undefined
    return false
  })
  return color
}

function readFontSize(fontXml: string): number | undefined {
  let sizePt: number | undefined
  forEachXlsxXmlElement(fontXml, 'sz', (element) => {
    const parsed = Number.parseFloat(element.attributes.val ?? '')
    sizePt = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    return false
  })
  return sizePt
}

// Why: `<b val="0"/>` explicitly turns the toggle off, which a named cell style
// does when it overrides an inherited bold or italic.
function hasToggleElement(fontXml: string, tagName: string): boolean {
  let enabled = false
  forEachXlsxXmlElement(fontXml, tagName, (element) => {
    enabled = element.attributes.val !== '0' && element.attributes.val !== 'false'
    return false
  })
  return enabled
}
