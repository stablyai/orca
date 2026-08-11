import React, { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import {
  SPREADSHEET_ALIGNMENT_CLASSES,
  getSpreadsheetCellAlignmentClass
} from './spreadsheet-cell-alignment'
import { computeSpreadsheetTextOverflowWidth } from './spreadsheet-text-overflow'
import {
  buildSpreadsheetMergeIndex,
  planSpreadsheetMergePlacement
} from './spreadsheet-merged-cells'
import { SpreadsheetGridOverlay } from './SpreadsheetGridOverlay'
import { buildSpreadsheetOverlayPlacements } from './spreadsheet-grid-overlay'
import type { ResolvedXlsxSparkline } from './xlsx-sparkline'
import type { XlsxSheetDrawing } from './xlsx-drawings'
import type { XlsxMergedRange } from './xlsx-worksheet-layout'
import {
  SPREADSHEET_GRID_BASE_FONT_PX,
  SPREADSHEET_GRID_COLUMN_OVERSCAN,
  SPREADSHEET_GRID_OVERSCAN,
  SPREADSHEET_GRID_ROW_HEIGHT,
  SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX,
  buildSpreadsheetGridTemplate,
  computeSpreadsheetColumnWidths,
  padSpreadsheetHeader
} from './spreadsheet-grid-columns'

type SpreadsheetGridProps = {
  /** First row of the sheet, rendered as the sticky heading row. */
  header: readonly string[]
  /** Remaining rows, virtualized. */
  rows: readonly (readonly string[])[]
  columnCount: number
  /**
   * Per-cell fill, text colour and bold, positionally matching `rows`. Rows and
   * cells may be absent; a workbook with no styling at all passes nothing.
   */
  cellStyles?: readonly (readonly (SpreadsheetCellStyle | undefined)[])[]
  /** Column widths the file declares, by index; content sizing fills the gaps. */
  declaredColumnWidths?: readonly (number | undefined)[]
  /** Row heights the file declares, by index; the default height fills the gaps. */
  declaredRowHeights?: readonly (number | undefined)[]
  /** Merged ranges the file declares. */
  mergedRanges?: readonly XlsxMergedRange[]
  /** Charts and images the file anchors over its cells. */
  drawings?: readonly XlsxSheetDrawing[]
  /** In-cell sparklines by row and column. */
  sparklines?: readonly (readonly (ResolvedXlsxSparkline | undefined)[] | undefined)[]
  /**
   * `center` for the generated column letters of a workbook; `left` for a CSV,
   * whose heading row holds the file's own first row of text.
   */
  headerAlignment?: 'left' | 'center'
}

/** Visual styling a data file declares for one cell. */
export type SpreadsheetCellStyle = {
  backgroundColor?: string
  textColor?: string
  bold?: boolean
  italic?: boolean
  /** Font size relative to the file's own default. */
  fontScale?: number
  horizontalAlignment?: 'left' | 'right' | 'center'
  wrapText?: boolean
  borders?: {
    top?: SpreadsheetCellBorderEdge
    right?: SpreadsheetCellBorderEdge
    bottom?: SpreadsheetCellBorderEdge
    left?: SpreadsheetCellBorderEdge
  }
}

export type SpreadsheetCellBorderEdge = { width: string; style: string; color?: string }

// Why: the file's own alignment wins; inferring from the value is the fallback,
// and only a left-aligned label overflows to the right.
function resolveCellAlignment(
  cell: string,
  cellStyle: SpreadsheetCellStyle | undefined
): 'left' | 'right' | 'center' {
  if (cellStyle?.horizontalAlignment !== undefined) {
    return cellStyle.horizontalAlignment
  }
  return getSpreadsheetCellAlignmentClass(cell).startsWith('justify-start') ? 'left' : 'center'
}

function buildCellBorderStyle(borders: SpreadsheetCellStyle['borders']): React.CSSProperties {
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

// Why: shared by CsvViewer and XlsxViewer — both render a read-only sheet of
// strings, and duplicating a virtualized grid twice would let the two drift.
// Both axes are virtualized via @tanstack/react-virtual: rows because a file can
// have 100k+ of them, and columns because a sheet whose last used cell sits far
// to the right reports thousands, which would otherwise put a cell element in
// every rendered row for each one. We use CSS grid with a shared
// grid-template-columns rather than a <table>, because absolutely-positioned
// virtualized rows break a table's column-width synchronization — the header
// would size itself independently of the body, leaving values squashed together.
// The off-screen columns collapse into one spacer track on each side, which keeps
// the sticky row-number column in normal flow.
//
// Callers that switch the rendered sheet should pass a `key` so scroll position
// and virtualizer measurements reset with the data.
export function SpreadsheetGrid({
  header,
  rows,
  columnCount,
  cellStyles,
  declaredColumnWidths,
  declaredRowHeights,
  mergedRanges,
  drawings,
  sparklines,
  headerAlignment = 'left'
}: SpreadsheetGridProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Why: reuse the editor's own zoom level rather than a control of our own, so
  // the sheet zooms with the same shortcuts as every other editor surface and
  // remembers the level across tabs.
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const fontSizePx = computeEditorFontSize(SPREADSHEET_GRID_BASE_FONT_PX, editorFontZoomLevel)
  const zoomScale = fontSizePx / SPREADSHEET_GRID_BASE_FONT_PX
  const rowHeightPx = Math.round(SPREADSHEET_GRID_ROW_HEIGHT * zoomScale)
  const rowNumberColumnPx = Math.round(SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX * zoomScale)
  // Why: the header bands sit a step below the cell text, as both Excel and
  // Sheets do. Inline rather than a utility because a Tailwind `text-[…]`
  // arbitrary value cannot be disambiguated between a size and a colour.
  const headerFontSizePx = Math.round(fontSizePx * 0.85)
  const paddedHeader = useMemo(
    () => padSpreadsheetHeader(header, columnCount),
    [header, columnCount]
  )
  const columnWidths = useMemo(
    () =>
      computeSpreadsheetColumnWidths({
        header: paddedHeader,
        rows,
        columnCount,
        declaredColumnWidths,
        zoomScale
      }),
    [paddedHeader, rows, columnCount, declaredColumnWidths, zoomScale]
  )
  const mergeIndex = useMemo(() => buildSpreadsheetMergeIndex(mergedRanges ?? []), [mergedRanges])
  const overlay = useMemo(
    () =>
      buildSpreadsheetOverlayPlacements({
        drawings,
        sparklines,
        mergeIndex,
        columnWidths,
        rowCount: rows.length,
        getRowHeight: (index) =>
          Math.round((declaredRowHeights?.[index] ?? SPREADSHEET_GRID_ROW_HEIGHT) * zoomScale),
        rowNumberColumnPx
      }),
    [
      drawings,
      sparklines,
      mergeIndex,
      columnWidths,
      rows,
      declaredRowHeights,
      zoomScale,
      rowNumberColumnPx
    ]
  )

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      Math.round((declaredRowHeights?.[index] ?? SPREADSHEET_GRID_ROW_HEIGHT) * zoomScale),
    overscan: SPREADSHEET_GRID_OVERSCAN,
    getItemKey: (index) => index
  })
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: columnCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => columnWidths[index] ?? 0,
    overscan: SPREADSHEET_GRID_COLUMN_OVERSCAN,
    getItemKey: (index) => index
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualColumns = columnVirtualizer.getVirtualItems()
  const columnsTotalWidth = columnVirtualizer.getTotalSize()
  const leadingSpacerPx = virtualColumns[0]?.start ?? 0
  const lastVirtualColumn = virtualColumns.at(-1)
  const trailingSpacerPx =
    lastVirtualColumn === undefined
      ? 0
      : Math.max(0, columnsTotalWidth - lastVirtualColumn.start - lastVirtualColumn.size)
  const firstRenderedColumn = virtualColumns[0]?.index ?? 0
  const lastRenderedColumn = lastVirtualColumn?.index ?? 0
  const gridTemplate = useMemo(
    () =>
      buildSpreadsheetGridTemplate({
        columnWidths: virtualColumns.map((virtualColumn) => virtualColumn.size),
        rowNumberColumnPx,
        leadingSpacerPx,
        trailingSpacerPx
      }),
    [virtualColumns, rowNumberColumnPx, leadingSpacerPx, trailingSpacerPx]
  )

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto scrollbar-editor bg-spreadsheet-surface text-spreadsheet-foreground tabular-nums"
      style={{ fontSize: fontSizePx }}
    >
      <div
        role="table"
        aria-rowcount={rows.length + 1}
        aria-colcount={columnCount + 1}
        className="relative inline-block min-w-full"
        style={{ width: rowNumberColumnPx + columnsTotalWidth }}
      >
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-10 grid bg-spreadsheet-header"
          style={{ gridTemplateColumns: gridTemplate, height: rowHeightPx }}
        >
          <div
            role="columnheader"
            className="sticky left-0 z-20 flex items-center justify-center border-b border-r border-spreadsheet-gridline-strong bg-spreadsheet-header font-normal text-spreadsheet-header-foreground"
            style={{ fontSize: headerFontSizePx }}
          >
            #
          </div>
          <div aria-hidden className="border-b border-spreadsheet-gridline-strong" />
          {virtualColumns.map((virtualColumn) => {
            const cell = paddedHeader[virtualColumn.index] ?? ''
            return (
              <div
                role="columnheader"
                aria-colindex={virtualColumn.index + 2}
                key={virtualColumn.key}
                className={cn(
                  'flex items-center overflow-hidden border-b border-r border-spreadsheet-gridline-strong px-2 font-medium text-spreadsheet-header-foreground',
                  headerAlignment === 'center' ? 'justify-center' : 'justify-start'
                )}
                style={{ fontSize: headerFontSizePx }}
              >
                <span className="truncate" title={cell}>
                  {cell}
                </span>
              </div>
            )
          })}
          <div aria-hidden className="border-b border-spreadsheet-gridline-strong" />
        </div>
        {/* Why: role="rowgroup" keeps the table's owned-row relationship intact —
        a generic element between role="table" and the data rows can stop
        assistive technology from exposing them. */}
        <div
          role="rowgroup"
          style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
        >
          {virtualRows.map((virtualRow) => {
            return (
              <div
                role="row"
                aria-rowindex={virtualRow.index + 2}
                key={virtualRow.key}
                data-index={virtualRow.index}
                className="group grid hover:bg-spreadsheet-row-hover"
                style={{
                  gridTemplateColumns: gridTemplate,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: virtualRow.size,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <div
                  role="rowheader"
                  className="sticky left-0 z-[5] flex items-center justify-center border-b border-r border-spreadsheet-gridline bg-spreadsheet-header px-2 text-spreadsheet-header-foreground group-hover:bg-spreadsheet-gridline"
                  style={{ fontSize: headerFontSizePx }}
                >
                  {virtualRow.index + 1}
                </div>
                <div aria-hidden className="border-b border-spreadsheet-gridline" />
                {virtualColumns.map((virtualColumn) => {
                  const columnIndex = virtualColumn.index
                  const merge = mergeIndex.find(virtualRow.index, columnIndex)
                  const mergePlacement =
                    merge === undefined
                      ? null
                      : planSpreadsheetMergePlacement({
                          merge,
                          rowIndex: virtualRow.index,
                          columnIndex,
                          firstRenderedColumn,
                          lastRenderedColumn
                        })
                  // Why: another cell of the same merge already covers this one.
                  if (merge !== undefined && mergePlacement === null) {
                    return null
                  }
                  const valueRowIndex = merge?.rowIndex ?? virtualRow.index
                  const valueColumnIndex = merge?.columnIndex ?? columnIndex
                  const cell =
                    mergePlacement !== null && !mergePlacement.showsValue
                      ? ''
                      : (rows[valueRowIndex]?.[valueColumnIndex] ?? '')
                  const cellStyle = cellStyles?.[valueRowIndex]?.[valueColumnIndex]
                  // Why: a left-aligned label runs across empty neighbours the way
                  // a spreadsheet draws it, instead of being clipped to its column.
                  const overflowWidth =
                    cellStyle?.wrapText === true ||
                    mergePlacement !== null ||
                    cell === '' ||
                    resolveCellAlignment(cell, cellStyle) !== 'left'
                      ? null
                      : computeSpreadsheetTextOverflowWidth({
                          row: rows[valueRowIndex] ?? [],
                          columnIndex,
                          columnCount,
                          columnWidths,
                          hasBackground: (index) =>
                            cellStyles?.[valueRowIndex]?.[index]?.backgroundColor !== undefined
                        })
                  return (
                    <div
                      role="cell"
                      aria-colindex={columnIndex + 2}
                      key={virtualColumn.key}
                      className={cn(
                        'flex border-b border-r border-spreadsheet-gridline px-2',
                        overflowWidth === null ? 'overflow-hidden' : 'overflow-visible',
                        // Why: an author-set alignment is a decision; inferring
                        // from the value is only the fallback when there is none.
                        cellStyle?.horizontalAlignment === undefined
                          ? getSpreadsheetCellAlignmentClass(cell)
                          : SPREADSHEET_ALIGNMENT_CLASSES[cellStyle.horizontalAlignment],
                        cellStyle?.wrapText === true
                          ? 'items-start py-1 whitespace-pre-wrap break-words'
                          : 'items-center',
                        cellStyle?.bold === true && 'font-semibold',
                        cellStyle?.italic === true && 'italic'
                      )}
                      // Why: these colours come from the opened file, not from the
                      // design system, so no token can express them. A cell that
                      // declares none keeps the theme's own foreground above.
                      style={{
                        ...(cellStyle?.backgroundColor === undefined
                          ? {}
                          : {
                              backgroundColor: cellStyle.backgroundColor,
                              color: cellStyle.textColor
                            }),
                        ...(cellStyle?.fontScale === undefined
                          ? {}
                          : { fontSize: Math.round(fontSizePx * cellStyle.fontScale) }),
                        // Why: an author-set edge replaces the default gridline on
                        // that side only, so a cell with one underline keeps the
                        // grid intact everywhere else.
                        ...buildCellBorderStyle(cellStyle?.borders),
                        ...(mergePlacement === null
                          ? {}
                          : { gridColumn: `span ${mergePlacement.columnSpan}` })
                      }}
                      title={cell}
                    >
                      <span
                        className={cn(
                          cellStyle?.wrapText === true ? 'min-w-0' : 'truncate',
                          // Why: a label may run across empty columns, but never out
                          // of its own row — a 24pt title in a short row bled over
                          // the band below it. The span clips its own height while
                          // still being allowed to be wider than the cell.
                          overflowWidth === null ? undefined : 'max-h-full overflow-hidden'
                        )}
                        style={overflowWidth === null ? undefined : { maxWidth: overflowWidth }}
                      >
                        {cell}
                      </span>
                    </div>
                  )
                })}
                <div aria-hidden className="border-b border-spreadsheet-gridline" />
              </div>
            )
          })}
        </div>
        <SpreadsheetGridOverlay placements={overlay} />
      </div>
    </div>
  )
}
