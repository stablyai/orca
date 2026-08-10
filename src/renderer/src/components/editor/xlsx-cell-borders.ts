import { resolveXlsxColor } from './xlsx-color'
import type { XlsxThemePalette } from './xlsx-theme-palette'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/** One edge of a cell border, as CSS. */
export type XlsxBorderEdge = { width: string; style: string; color?: string }

export type XlsxCellBorders = {
  top?: XlsxBorderEdge
  right?: XlsxBorderEdge
  bottom?: XlsxBorderEdge
  left?: XlsxBorderEdge
}

const BORDER_EDGE_NAMES = ['top', 'right', 'bottom', 'left'] as const

// Why: SpreadsheetML names border weights rather than giving widths. These are
// the CSS equivalents; `hair` is the thinnest line Excel draws and `double` needs
// the style, not the width, to read correctly.
const BORDER_STYLES: Record<string, { width: string; style: string }> = {
  hair: { width: '1px', style: 'solid' },
  thin: { width: '1px', style: 'solid' },
  medium: { width: '2px', style: 'solid' },
  thick: { width: '3px', style: 'solid' },
  dotted: { width: '1px', style: 'dotted' },
  dashed: { width: '1px', style: 'dashed' },
  dashDot: { width: '1px', style: 'dashed' },
  dashDotDot: { width: '1px', style: 'dashed' },
  mediumDashed: { width: '2px', style: 'dashed' },
  mediumDashDot: { width: '2px', style: 'dashed' },
  mediumDashDotDot: { width: '2px', style: 'dashed' },
  slantDashDot: { width: '1px', style: 'dashed' },
  double: { width: '3px', style: 'double' }
}

/** Borders per `<borders>` index; undefined for an entry that draws nothing. */
export function parseXlsxCellBorders(
  stylesXml: string,
  themePalette: XlsxThemePalette
): (XlsxCellBorders | undefined)[] {
  const borders: (XlsxCellBorders | undefined)[] = []

  forEachXlsxXmlElement(stylesXml, 'borders', (bordersBlock) => {
    forEachXlsxXmlElement(bordersBlock.inner, 'border', (border) => {
      borders.push(readBorderEdges(border.inner, themePalette))
    })
    return false
  })

  return borders
}

function readBorderEdges(
  borderXml: string,
  themePalette: XlsxThemePalette
): XlsxCellBorders | undefined {
  const edges: XlsxCellBorders = {}

  for (const edgeName of BORDER_EDGE_NAMES) {
    forEachXlsxXmlElement(borderXml, edgeName, (edge) => {
      // Why: `style="none"` and a bare `<top/>` both mean no line. Excel writes
      // the empty element on every cell that has any other edge set.
      const borderStyle = BORDER_STYLES[edge.attributes.style ?? '']
      if (borderStyle === undefined) {
        return false
      }
      let color: string | undefined
      forEachXlsxXmlElement(edge.inner, 'color', (element) => {
        color = resolveXlsxColor(element.attributes, themePalette) ?? undefined
        return false
      })
      edges[edgeName] = { ...borderStyle, color }
      return false
    })
  }

  return Object.keys(edges).length === 0 ? undefined : edges
}
