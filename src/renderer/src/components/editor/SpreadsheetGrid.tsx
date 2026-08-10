import React, { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { getSpreadsheetCellAlignmentClass } from './spreadsheet-cell-alignment'
import {
  SPREADSHEET_GRID_OVERSCAN,
  SPREADSHEET_GRID_ROW_HEIGHT,
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
   * `center` for the generated column letters of a workbook; `left` for a CSV,
   * whose heading row holds the file's own first row of text.
   */
  headerAlignment?: 'left' | 'center'
}

// Why: shared by CsvViewer and XlsxViewer — both render a read-only sheet of
// strings, and duplicating a virtualized grid twice would let the two drift.
// Row virtualization via @tanstack/react-virtual keeps large files (100k+ rows)
// responsive. We use CSS grid with a shared grid-template-columns rather than a
// <table>, because absolutely-positioned virtualized rows break a table's
// column-width synchronization — the header would size itself independently of
// the body, leaving values squashed together.
//
// Callers that switch the rendered sheet should pass a `key` so scroll position
// and virtualizer measurements reset with the data.
export function SpreadsheetGrid({
  header,
  rows,
  columnCount,
  headerAlignment = 'left'
}: SpreadsheetGridProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const paddedHeader = useMemo(
    () => padSpreadsheetHeader(header, columnCount),
    [header, columnCount]
  )
  const gridTemplate = useMemo(
    () =>
      buildSpreadsheetGridTemplate(
        computeSpreadsheetColumnWidths({ header: paddedHeader, rows, columnCount })
      ),
    [paddedHeader, rows, columnCount]
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SPREADSHEET_GRID_ROW_HEIGHT,
    overscan: SPREADSHEET_GRID_OVERSCAN,
    getItemKey: (index) => index
  })
  const virtualRows = virtualizer.getVirtualItems()

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto scrollbar-editor font-mono text-xs"
    >
      <div
        role="table"
        aria-rowcount={rows.length + 1}
        aria-colcount={columnCount + 1}
        className="inline-block min-w-full"
        style={{ width: 'max-content' }}
      >
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-10 grid bg-muted/90 backdrop-blur"
          style={{ gridTemplateColumns: gridTemplate, height: SPREADSHEET_GRID_ROW_HEIGHT }}
        >
          <div
            role="columnheader"
            className="sticky left-0 z-20 flex items-center justify-end border-b border-r border-border bg-muted/90 px-2 text-[10px] font-normal text-muted-foreground"
          >
            #
          </div>
          {paddedHeader.map((cell, columnIndex) => (
            <div
              role="columnheader"
              key={columnIndex}
              className={cn(
                'flex items-center overflow-hidden border-b border-r border-border px-2 font-medium text-foreground',
                headerAlignment === 'center' ? 'justify-center' : 'justify-start'
              )}
            >
              <span className="truncate" title={cell}>
                {cell}
              </span>
            </div>
          ))}
        </div>
        {/* Why: role="rowgroup" keeps the table's owned-row relationship intact —
        a generic element between role="table" and the data rows can stop
        assistive technology from exposing them. */}
        <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index] ?? []
            return (
              <div
                role="row"
                aria-rowindex={virtualRow.index + 2}
                key={virtualRow.key}
                data-index={virtualRow.index}
                className="group grid hover:bg-accent/40"
                style={{
                  gridTemplateColumns: gridTemplate,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: SPREADSHEET_GRID_ROW_HEIGHT,
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <div
                  role="rowheader"
                  className="sticky left-0 z-[5] flex items-center justify-end border-b border-r border-border bg-muted/90 px-2 text-[10px] text-muted-foreground backdrop-blur group-hover:bg-accent/40"
                >
                  {virtualRow.index + 1}
                </div>
                {Array.from({ length: columnCount }).map((_, columnIndex) => {
                  const cell = row[columnIndex] ?? ''
                  return (
                    <div
                      role="cell"
                      key={columnIndex}
                      className={cn(
                        'flex items-center overflow-hidden border-b border-r border-border px-2 text-foreground',
                        getSpreadsheetCellAlignmentClass(cell)
                      )}
                      title={cell}
                    >
                      <span className="truncate">{cell}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
