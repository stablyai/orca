import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { CsvColumnResizeHandle } from './CsvColumnResizeHandle'
import { CsvCellValue } from './CsvCellValue'

const ROW_HEIGHT = 28
// Keep the scroll surface below Chromium's layout extent limit.
const SCROLL_WINDOW_ROWS = 500_000

export function CsvGrid({
  header,
  rowCount,
  columnCount,
  sampleRows,
  getRow,
  onVisibleRows,
  onOpenUrl
}: {
  header: string[]
  rowCount: number
  columnCount: number
  sampleRows: string[][]
  getRow: (index: number) => string[] | undefined
  onVisibleRows?: (first: number, last: number) => void
  onOpenUrl?: (url: string, event: React.MouseEvent<HTMLAnchorElement>) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [requestedWindowStart, setWindowStart] = useState(0)
  const windowStart = Math.min(
    requestedWindowStart,
    Math.floor(Math.max(0, rowCount - 1) / SCROLL_WINDOW_ROWS) * SCROLL_WINDOW_ROWS
  )
  const [widthOverrides, setWidthOverrides] = useState<Record<number, number>>({})
  const rowNumberWidth = Math.max(48, String(rowCount).length * 8 + 16)
  const widths = useMemo(() => {
    const result = Array.from({ length: columnCount }, () => 80)
    for (const row of [header, ...sampleRows.slice(0, 200)]) {
      row.forEach((cell, index) => {
        if (index < columnCount) {
          result[index] = Math.max(result[index]!, Math.min(320, cell.length * 7 + 24))
        }
      })
    }
    return result
  }, [header, sampleRows, columnCount])
  const rows = useVirtualizer({
    count: Math.min(SCROLL_WINDOW_ROWS, Math.max(0, rowCount - windowStart)),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    paddingStart: ROW_HEIGHT
  })
  const columns = useVirtualizer({
    horizontal: true,
    count: columnCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => widthOverrides[index] ?? widths[index] ?? 80,
    paddingStart: rowNumberWidth,
    overscan: 2
  })
  useLayoutEffect(() => columns.measure(), [columns, widths])
  const virtualRows = rows.getVirtualItems()
  const virtualColumns = columns.getVirtualItems()
  const first = virtualRows[0]?.index
  const last = virtualRows.at(-1)?.index
  useEffect(() => {
    if (first !== undefined && last !== undefined) {
      onVisibleRows?.(first + windowStart, last + windowStart)
    }
  }, [first, last, windowStart, onVisibleRows])
  const resize = useCallback(
    (index: number, width: number) => {
      setWidthOverrides((previous) => ({ ...previous, [index]: width }))
      columns.resizeItem(index, width)
    },
    [columns]
  )
  const reset = useCallback((index: number) => resize(index, widths[index] ?? 80), [resize, widths])
  const totalWidth = columns.getTotalSize()
  const gridTemplate = `${rowNumberWidth}px ${Math.max(0, (virtualColumns[0]?.start ?? rowNumberWidth) - rowNumberWidth)}px ${virtualColumns.map((column) => `${column.size}px`).join(' ')} ${Math.max(0, totalWidth - (virtualColumns.at(-1)?.end ?? rowNumberWidth))}px`
  const moveWindow = (start: number): void => {
    setWindowStart(start)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  return (
    <>
      <div
        ref={scrollRef}
        data-testid="csv-scroll"
        className="relative min-h-0 flex-1 overflow-auto scrollbar-editor font-mono text-xs"
      >
        <div
          role="table"
          aria-rowcount={rowCount + 1}
          aria-colcount={columnCount + 1}
          className="relative min-w-full"
          style={{ width: totalWidth }}
        >
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid bg-muted/90 backdrop-blur"
            style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
          >
            <div
              role="columnheader"
              aria-colindex={1}
              className="sticky left-0 z-20 flex items-center justify-end border-b border-r border-border/60 bg-muted px-2 font-normal text-muted-foreground"
            >
              #
            </div>
            <div aria-hidden="true" />
            {virtualColumns.map((column) => (
              <div
                role="columnheader"
                aria-colindex={column.index + 2}
                aria-label={header[column.index] ?? ''}
                key={column.key}
                className="relative flex min-w-0 items-center border-b border-r border-border/60 px-2 font-medium text-foreground"
              >
                <span className="truncate" title={header[column.index] ?? ''}>
                  {header[column.index] ?? ''}
                </span>
                <CsvColumnResizeHandle
                  index={column.index}
                  width={column.size}
                  onResize={resize}
                  onReset={reset}
                />
              </div>
            ))}
            <div aria-hidden="true" />
          </div>
          <div
            className="relative"
            style={{ height: Math.max(0, rows.getTotalSize() - ROW_HEIGHT) }}
          >
            {virtualRows.map((virtualRow) => {
              const index = virtualRow.index + windowStart
              const row = getRow(index)
              return (
                <div
                  role="row"
                  aria-rowindex={index + 2}
                  aria-busy={row === undefined}
                  key={virtualRow.key}
                  data-index={index}
                  className="group absolute left-0 top-0 grid hover:bg-accent/40"
                  style={{
                    gridTemplateColumns: gridTemplate,
                    height: ROW_HEIGHT,
                    width: totalWidth,
                    transform: `translateY(${virtualRow.start - ROW_HEIGHT}px)`
                  }}
                >
                  <div
                    role="rowheader"
                    aria-colindex={1}
                    className="sticky left-0 z-10 flex items-center justify-end border-b border-r border-border/40 bg-background px-2 text-muted-foreground group-hover:bg-accent"
                  >
                    {index + 1}
                  </div>
                  <div aria-hidden="true" />
                  {virtualColumns.map((column) => (
                    <div
                      role="cell"
                      aria-colindex={column.index + 2}
                      key={column.key}
                      className="flex min-w-0 items-center overflow-hidden border-b border-r border-border/40 px-2 text-foreground"
                      title={row?.[column.index] ?? ''}
                    >
                      <CsvCellValue
                        value={
                          row ? (row[column.index] ?? '') : translate('csv.loadingCell', 'Loading…')
                        }
                        onOpenUrl={onOpenUrl}
                      />
                    </div>
                  ))}
                  <div aria-hidden="true" />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {rowCount > SCROLL_WINDOW_ROWS && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="xs"
            disabled={windowStart === 0}
            onClick={() => moveWindow(Math.max(0, windowStart - SCROLL_WINDOW_ROWS))}
          >
            {translate('csv.previousRows', 'Previous rows')}
          </Button>
          <span>
            {translate('csv.rowWindow', 'Rows {{first}}–{{last}}', {
              first: (windowStart + 1).toLocaleString(),
              last: Math.min(rowCount, windowStart + SCROLL_WINDOW_ROWS).toLocaleString()
            })}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={windowStart + SCROLL_WINDOW_ROWS >= rowCount}
            onClick={() => moveWindow(windowStart + SCROLL_WINDOW_ROWS)}
          >
            {translate('csv.nextRows', 'Next rows')}
          </Button>
        </div>
      )}
    </>
  )
}
