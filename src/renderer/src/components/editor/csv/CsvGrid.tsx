import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { CsvColumnResizeHandle } from './CsvColumnResizeHandle'
import { CsvGridCell } from './CsvGridCell'
import type { CsvGridInteraction } from './csv-grid-interaction'
import type { CsvColumnWidths } from './csv-column-width-preferences'

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
  onOpenUrl,
  interaction,
  columnWidths,
  onColumnWidthsChange
}: {
  header: string[]
  rowCount: number
  columnCount: number
  sampleRows: string[][]
  getRow: (index: number) => string[] | undefined
  onVisibleRows?: (first: number, last: number) => void
  onOpenUrl?: (url: string, event: React.MouseEvent<HTMLAnchorElement>) => void
  interaction?: CsvGridInteraction
  columnWidths?: CsvColumnWidths
  onColumnWidthsChange?: (widths: CsvColumnWidths) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const gridId = useId()
  const dragging = useRef(false)
  const scrolledFocusVersion = useRef(-1)
  const focusGrid = (): void => gridRef.current?.focus({ preventScroll: true })
  const [requestedWindowStart, setWindowStart] = useState(0)
  const windowStart = Math.min(
    requestedWindowStart,
    Math.floor(Math.max(0, rowCount - 1) / SCROLL_WINDOW_ROWS) * SCROLL_WINDOW_ROWS
  )
  const [localWidths, setLocalWidths] = useState<CsvColumnWidths>({})
  const widthOverrides = columnWidths ?? localWidths
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
  useLayoutEffect(() => columns.measure(), [columns, widths, columnWidths])
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
      const next = { ...widthOverrides, [index]: width }
      if (onColumnWidthsChange) {
        onColumnWidthsChange(next)
      } else {
        setLocalWidths(next)
      }
      columns.resizeItem(index, width)
    },
    [columns, onColumnWidthsChange, widthOverrides]
  )
  const reset = (index: number): void => {
    const next = { ...widthOverrides }
    delete next[index]
    if (onColumnWidthsChange) {
      onColumnWidthsChange(next)
    } else {
      setLocalWidths(next)
    }
    columns.resizeItem(index, widths[index] ?? 80)
  }
  const active = interaction?.selection?.focus
  useLayoutEffect(() => {
    if (!active || scrolledFocusVersion.current === interaction?.focusVersion) {
      return
    }
    if (interaction?.editing) {
      scrolledFocusVersion.current = interaction.focusVersion
      return
    }
    const targetWindow =
      Math.floor(Math.max(0, active.row - 1) / SCROLL_WINDOW_ROWS) * SCROLL_WINDOW_ROWS
    if (targetWindow !== windowStart) {
      setWindowStart(targetWindow)
      return
    }
    if (active.row > 0) {
      rows.scrollToIndex(active.row - 1 - windowStart, { align: 'auto' })
    } else {
      scrollRef.current?.scrollTo({ top: 0 })
    }
    columns.scrollToIndex(active.column, { align: 'auto' })
    scrolledFocusVersion.current = interaction?.focusVersion ?? -1
  }, [active, interaction?.editing, interaction?.focusVersion, rows, columns, windowStart])
  useEffect(() => {
    const finish = (): void => {
      dragging.current = false
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
    }
  }, [])
  const pointerCell = (event: React.PointerEvent): { row: number; column: number } | null => {
    if (
      !(event.target instanceof Element) ||
      event.target.closest('a,textarea,[role="separator"]')
    ) {
      return null
    }
    const cell = event.target.closest('[data-csv-row]')
    if (!cell) {
      return null
    }
    const row = Number(cell.getAttribute('data-csv-row'))
    const column = Number(cell.getAttribute('data-csv-column'))
    return Number.isInteger(row) && Number.isInteger(column) ? { row, column } : null
  }
  const activeMounted =
    active &&
    virtualColumns.some((column) => column.index === active.column) &&
    (active.row === 0 || virtualRows.some((row) => row.index + windowStart + 1 === active.row))

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
        onScroll={(event) => {
          if (!interaction?.editing) {
            return
          }
          const position = interaction.editing.position
          const cell = gridRef.current
            ?.querySelector(
              `[data-csv-row="${position.row}"][data-csv-column="${position.column}"]`
            )
            ?.getBoundingClientRect()
          const viewport = event.currentTarget.getBoundingClientRect()
          // Caret visibility can scroll a clipped input while the user is still typing.
          if (
            cell &&
            cell.bottom > viewport.top + (position.row ? ROW_HEIGHT : 0) &&
            cell.top < viewport.bottom &&
            cell.right > viewport.left &&
            cell.left < viewport.right
          ) {
            return
          }
          if (!interaction.commit()) {
            if (position.row > 0) {
              rows.scrollToIndex(position.row - 1 - windowStart, { align: 'auto' })
            }
            columns.scrollToIndex(position.column, { align: 'auto' })
          }
        }}
      >
        <div
          ref={gridRef}
          role={interaction ? 'grid' : 'table'}
          data-testid="csv-grid"
          data-csv-owner={interaction?.ownerId}
          tabIndex={interaction ? 0 : undefined}
          aria-label={interaction ? translate('csv.editor', 'CSV editor') : undefined}
          aria-activedescendant={
            activeMounted ? `${gridId}-${active.row}-${active.column}` : undefined
          }
          onKeyDown={interaction?.keyDown}
          onCopy={interaction?.copy}
          onPaste={interaction?.paste}
          onPointerDown={(event) => {
            const cell = pointerCell(event)
            if (!interaction || !cell || event.button !== 0) {
              return
            }
            event.preventDefault()
            if (interaction.select(cell.row, cell.column, event.shiftKey)) {
              dragging.current = true
              focusGrid()
            }
          }}
          onPointerMove={(event) => {
            const cell = pointerCell(event)
            if (interaction && dragging.current && cell) {
              interaction.select(cell.row, cell.column, true)
            }
          }}
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
              <CsvGridCell
                key={column.key}
                id={`${gridId}-0-${column.index}`}
                header
                value={header[column.index] ?? ''}
                row={0}
                column={column.index}
                interaction={interaction}
                focusGrid={focusGrid}
              >
                <CsvColumnResizeHandle
                  index={column.index}
                  width={column.size}
                  onResize={resize}
                  onReset={reset}
                />
              </CsvGridCell>
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
                    <CsvGridCell
                      key={column.key}
                      id={`${gridId}-${index + 1}-${column.index}`}
                      value={
                        row ? (row[column.index] ?? '') : translate('csv.loadingCell', 'Loading…')
                      }
                      row={index + 1}
                      column={column.index}
                      interaction={interaction}
                      focusGrid={focusGrid}
                      onOpenUrl={onOpenUrl}
                    />
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
