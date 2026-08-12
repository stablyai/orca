import type { SpreadsheetCellStyle } from './SpreadsheetCell'

/**
 * The height a row needs for the tallest text it holds.
 *
 * Why this exists: a row the file leaves without a `customHeight` is auto-fitted
 * by Excel to its own content, so a heading at twice the body size gets a taller
 * row. Using one default height for every such row clipped exactly those rows —
 * the author never set a height because the application was going to measure it.
 *
 * A row the file *does* size explicitly is left alone, clipping included: that
 * height is the author's decision and Excel honours it the same way.
 */
export function computeSpreadsheetAutoRowHeight({
  rowStyles,
  baseRowHeightPx,
  fontSizePx
}: {
  /** Styles of the row's cells; a missing entry contributes the base size. */
  rowStyles: readonly (SpreadsheetCellStyle | undefined)[] | undefined
  baseRowHeightPx: number
  /** Rendered body font size, already zoomed. */
  fontSizePx: number
}): number {
  if (rowStyles === undefined) {
    return baseRowHeightPx
  }
  let largestScale = 1
  for (const style of rowStyles) {
    const scale = style?.fontScale
    if (scale !== undefined && scale > largestScale) {
      largestScale = scale
    }
  }
  if (largestScale <= 1) {
    return baseRowHeightPx
  }
  // Why: the glyphs plus the leading a spreadsheet leaves around them. The base
  // height already carries that padding for the base size, so the extra is scaled
  // from the font rather than from the row.
  const neededPx = Math.ceil(fontSizePx * largestScale * LINE_HEIGHT_RATIO + ROW_PADDING_PX)
  return Math.max(baseRowHeightPx, Math.min(MAX_AUTO_ROW_HEIGHT_PX, neededPx))
}

const LINE_HEIGHT_RATIO = 1.25
const ROW_PADDING_PX = 6
// Why: bound it so one absurd font size in a file cannot make a row taller than
// the viewport and hide every row after it.
const MAX_AUTO_ROW_HEIGHT_PX = 400
