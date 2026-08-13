import type React from 'react'
import { cn } from '@/lib/utils'
import {
  SPREADSHEET_ALIGNMENT_CLASSES,
  getSpreadsheetCellAlignmentClass
} from './spreadsheet-cell-alignment'

/** Visual styling a data file declares for one cell. */
export type SpreadsheetCellStyle = {
  backgroundColor?: string
  textColor?: string
  bold?: boolean
  italic?: boolean
  /** Font size relative to the file's own default. */
  fontScale?: number
  /** The typeface the cell declares, when it departs from the file's default. */
  fontFamily?: string
  horizontalAlignment?: 'left' | 'right' | 'center'
  verticalAlignment?: SpreadsheetVerticalAlignment
  /** Author-set indent level, in spreadsheet indent units. */
  indent?: number
  wrapText?: boolean
  borders?: {
    top?: SpreadsheetCellBorderEdge
    right?: SpreadsheetCellBorderEdge
    bottom?: SpreadsheetCellBorderEdge
    left?: SpreadsheetCellBorderEdge
  }
}

export type SpreadsheetCellBorderEdge = { width: string; style: string; color?: string }

export type SpreadsheetVerticalAlignment = 'top' | 'middle' | 'bottom'

const VERTICAL_ALIGNMENT_CLASSES: Record<SpreadsheetVerticalAlignment, string> = {
  top: 'items-start',
  middle: 'items-center',
  bottom: 'items-end'
}

// Why: a spreadsheet's indent level is about three space widths. Deriving it from
// the rendered font size rather than a fixed pixel count keeps the indent in
// proportion when the reader zooms.
const INDENT_EM_PER_LEVEL = 0.75
const MAX_INDENT_LEVEL = 15

/** The file's own alignment wins; inferring from the value is the fallback. */
export function resolveSpreadsheetCellAlignment(
  cell: string,
  cellStyle: SpreadsheetCellStyle | undefined
): 'left' | 'right' | 'center' {
  if (cellStyle?.horizontalAlignment !== undefined) {
    return cellStyle.horizontalAlignment
  }
  return getSpreadsheetCellAlignmentClass(cell).startsWith('justify-start') ? 'left' : 'center'
}

export function buildSpreadsheetCellBorderStyle(
  borders: SpreadsheetCellStyle['borders']
): React.CSSProperties {
  if (borders === undefined) {
    return {}
  }
  const edgeStyle = (edge: SpreadsheetCellBorderEdge | undefined): string | undefined =>
    edge === undefined ? undefined : `${edge.width} ${edge.style} ${edge.color ?? 'currentColor'}`
  return {
    borderTop: edgeStyle(borders.top),
    borderRight: edgeStyle(borders.right),
    borderBottom: edgeStyle(borders.bottom),
    borderLeft: edgeStyle(borders.left)
  }
}

/** Left padding for an author-set indent level, in pixels. */
export function computeSpreadsheetIndentPx(
  indent: number | undefined,
  fontSizePx: number
): number | undefined {
  if (indent === undefined || !Number.isFinite(indent) || indent <= 0) {
    return undefined
  }
  const indentPx = Math.round(Math.min(indent, MAX_INDENT_LEVEL) * fontSizePx * INDENT_EM_PER_LEVEL)
  // Why: a zero or negative result would emit `paddingLeft: 0` and cancel the
  // cell's own left padding, pushing the text against the gridline.
  return indentPx > 0 ? indentPx : undefined
}

type SpreadsheetCellProps = {
  cell: string
  cellStyle: SpreadsheetCellStyle | undefined
  /** One-based column index for assistive technology, already offset. */
  ariaColumnIndex: number
  fontSizePx: number
  /** Vertical alignment for a cell whose style declares none. */
  defaultVerticalAlignment: SpreadsheetVerticalAlignment
  /** Width a left-aligned label may run to across empty neighbours, or null. */
  overflowWidth: number | null
  /** Columns this cell spans when it anchors a merged range. */
  columnSpan?: number
  /**
   * Value to announce when the cell draws none itself. A merge that spans rows
   * hands its text to the overlay, which is outside the table — without this the
   * value would leave the accessibility tree with it.
   */
  ariaLabel?: string
}

export function SpreadsheetCell({
  cell,
  cellStyle,
  ariaColumnIndex,
  fontSizePx,
  defaultVerticalAlignment,
  overflowWidth,
  columnSpan,
  ariaLabel
}: SpreadsheetCellProps): React.JSX.Element {
  const wrapsText = cellStyle?.wrapText === true
  const indentPx = computeSpreadsheetIndentPx(cellStyle?.indent, fontSizePx)
  return (
    <div
      role="cell"
      aria-colindex={ariaColumnIndex}
      aria-label={ariaLabel}
      className={cn(
        'flex border-b border-r border-spreadsheet-gridline px-2',
        overflowWidth === null ? 'overflow-hidden' : 'overflow-visible',
        // Why: an author-set alignment is a decision; inferring from the value is
        // only the fallback when there is none.
        cellStyle?.horizontalAlignment === undefined
          ? getSpreadsheetCellAlignmentClass(cell)
          : SPREADSHEET_ALIGNMENT_CLASSES[cellStyle.horizontalAlignment],
        VERTICAL_ALIGNMENT_CLASSES[cellStyle?.verticalAlignment ?? defaultVerticalAlignment],
        wrapsText && 'py-1 whitespace-pre-wrap break-words',
        cellStyle?.bold === true && 'font-semibold',
        cellStyle?.italic === true && 'italic'
      )}
      // Why: these colours come from the opened file, not from the design system,
      // so no token can express them. A cell that declares none keeps the theme's
      // own foreground above.
      style={{
        ...(cellStyle?.backgroundColor === undefined
          ? {}
          : { backgroundColor: cellStyle.backgroundColor, color: cellStyle.textColor }),
        ...(cellStyle?.fontScale === undefined
          ? {}
          : { fontSize: Math.round(fontSizePx * cellStyle.fontScale) }),
        ...(cellStyle?.fontFamily === undefined ? {} : { fontFamily: cellStyle.fontFamily }),
        // Why: an author-set edge replaces the default gridline on that side only,
        // so a cell with one underline keeps the grid intact everywhere else.
        ...buildSpreadsheetCellBorderStyle(cellStyle?.borders),
        ...(indentPx === undefined ? {} : { paddingLeft: indentPx }),
        ...(columnSpan === undefined ? {} : { gridColumn: `span ${columnSpan}` })
      }}
      title={cell}
    >
      <span
        className={cn(
          wrapsText ? 'min-w-0' : 'truncate',
          // Why: `truncate` sets overflow-hidden, which lets flexbox shrink this
          // below its content and truncate it at the cell's edge — the maxWidth
          // alone was being ignored, so a label with empty columns beside it still
          // ended in an ellipsis. It must also clip its own height, since a tall
          // label in a short row bled over the band below it.
          overflowWidth === null ? undefined : 'max-h-full shrink-0 overflow-hidden'
        )}
        style={overflowWidth === null ? undefined : { maxWidth: overflowWidth }}
      >
        {cell}
      </span>
    </div>
  )
}
