import React, { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { getSpreadsheetCellAlignmentClass } from './spreadsheet-cell-alignment'
import {
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
  headerAlignment = 'left'
}: SpreadsheetGridProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const paddedHeader = useMemo(
    () => padSpreadsheetHeader(header, columnCount),
    [header, columnCount]
  )
  const columnWidths = useMemo(
    () => computeSpreadsheetColumnWidths({ header: paddedHeader, rows, columnCount }),
    [paddedHeader, rows, columnCount]
  )

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SPREADSHEET_GRID_ROW_HEIGHT,
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
  const gridTemplate = useMemo(
    () =>
      buildSpreadsheetGridTemplate({
        columnWidths: virtualColumns.map((virtualColumn) => virtualColumn.size),
        leadingSpacerPx,
        trailingSpacerPx
      }),
    [virtualColumns, leadingSpacerPx, trailingSpacerPx]
  )

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto scrollbar-editor bg-spreadsheet-surface text-[13px] text-spreadsheet-foreground tabular-nums"
    >
      <div
        role="table"
        aria-rowcount={rows.length + 1}
        aria-colcount={columnCount + 1}
        className="inline-block min-w-full"
        style={{ width: SPREADSHEET_GRID_ROW_NUMBER_COLUMN_PX + columnsTotalWidth }}
      >
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-10 grid bg-spreadsheet-header"
          style={{ gridTemplateColumns: gridTemplate, height: SPREADSHEET_GRID_ROW_HEIGHT }}
        >
          <div
            role="columnheader"
            className="sticky left-0 z-20 flex items-center justify-center border-b border-r border-spreadsheet-gridline-strong bg-spreadsheet-header text-[11px] font-normal text-spreadsheet-header-foreground"
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
                  'flex items-center overflow-hidden border-b border-r border-spreadsheet-gridline-strong px-2 text-[11px] font-medium text-spreadsheet-header-foreground',
                  headerAlignment === 'center' ? 'justify-center' : 'justify-start'
                )}
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
            const row = rows[virtualRow.index] ?? []
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
                  height: SPREADSHEET_GRID_ROW_HEIGHT,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <div
                  role="rowheader"
                  className="sticky left-0 z-[5] flex items-center justify-center border-b border-r border-spreadsheet-gridline bg-spreadsheet-header px-2 text-[11px] text-spreadsheet-header-foreground group-hover:bg-spreadsheet-gridline"
                >
                  {virtualRow.index + 1}
                </div>
                <div aria-hidden className="border-b border-spreadsheet-gridline" />
                {virtualColumns.map((virtualColumn) => {
                  const columnIndex = virtualColumn.index
                  const cell = row[columnIndex] ?? ''
                  const cellStyle = cellStyles?.[virtualRow.index]?.[columnIndex]
                  return (
                    <div
                      role="cell"
                      aria-colindex={columnIndex + 2}
                      key={virtualColumn.key}
                      className={cn(
                        'flex items-center overflow-hidden border-b border-r border-spreadsheet-gridline px-2',
                        getSpreadsheetCellAlignmentClass(cell),
                        cellStyle?.bold === true && 'font-semibold'
                      )}
                      // Why: these colours come from the opened file, not from the
                      // design system, so no token can express them. A cell that
                      // declares none keeps the theme's own foreground above.
                      style={
                        cellStyle?.backgroundColor === undefined
                          ? undefined
                          : {
                              backgroundColor: cellStyle.backgroundColor,
                              color: cellStyle.textColor
                            }
                      }
                      title={cell}
                    >
                      <span className="truncate">{cell}</span>
                    </div>
                  )
                })}
                <div aria-hidden className="border-b border-spreadsheet-gridline" />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
