import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { DbColumnFilter, DbSafeError, QueryResult } from '../../../../shared/database-types'
import type { DbQueryRefine } from '@/store/slices/database'
import { copyCell, formatCell } from './data-grid-cell-format'
import { DataGridColumnHeader } from './DataGridColumnHeader'
import { filterFor } from './data-grid-filters'
import { ordinalSortDirectionFor } from './data-grid-sort-state'

const ROW_HEIGHT = 24
const OVERSCAN = 16
const COL_MIN_PX = 120
const COL_MAX_PX = 320

// Handlers that turn the free-form results grid into a server-side sort/filter
// surface (wrapping the last read). Omitted → plain read-only headers.
export type ResultsGridRefine = {
  refine: DbQueryRefine
  onSort: (ordinal: number) => void
  onFilter: (column: string, filter: DbColumnFilter | null) => void
  onPage: (delta: number) => void
}

export function ResultsGrid({
  result,
  error,
  running,
  refine
}: {
  result?: QueryResult
  error?: DbSafeError
  running: boolean
  refine?: ResultsGridRefine
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = result?.rows ?? []
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => index
  })

  if (running) {
    return <GridPlaceholder spinning text={translate('auto.components.database.ResultsGrid.running', 'Running…')} />
  }
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="max-w-md text-center text-xs text-destructive">{error.safeMessage}</p>
      </div>
    )
  }
  if (!result) {
    return (
      <GridPlaceholder
        text={translate('auto.components.database.ResultsGrid.empty', 'Run a query to see results')}
      />
    )
  }

  const gridTemplate =
    result.columns.length > 0
      ? result.columns.map(() => `minmax(${COL_MIN_PX}px, ${COL_MAX_PX}px)`).join(' ')
      : '1fr'
  // Filtering a wrapped subquery is by name → ambiguous for duplicate names; only
  // uniquely-named columns get a filter control.
  const nameCounts = new Map<string, number>()
  for (const col of result.columns) {
    nameCounts.set(col.name, (nameCounts.get(col.name) ?? 0) + 1)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        <div className="inline-block min-w-full font-mono text-xs">
          <div
            className="sticky top-0 z-10 grid border-b border-border bg-muted/90 backdrop-blur"
            style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
          >
            {result.columns.map((col, i) =>
              refine ? (
                <DataGridColumnHeader
                  key={`${col.name}-${i}`}
                  name={col.name}
                  dataType={col.dataType}
                  sortDirection={ordinalSortDirectionFor(refine.refine.sort, i + 1)}
                  onSort={() => refine.onSort(i + 1)}
                  filter={filterFor(refine.refine.filters, col.name)}
                  onFilter={(filter) => refine.onFilter(col.name, filter)}
                  filterable={(nameCounts.get(col.name) ?? 0) === 1}
                />
              ) : (
                <div
                  key={`${col.name}-${i}`}
                  className="flex items-center truncate border-r border-border/60 px-2 font-medium"
                  title={col.dataType ? `${col.name} · ${col.dataType}` : col.name}
                >
                  {col.name}
                </div>
              )
            )}
          </div>
          {rows.length === 0 ? (
            <div className="px-2 py-2 text-muted-foreground">
              {translate('auto.components.database.ResultsGrid.noRows', 'No rows returned')}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]
                return (
                  <div
                    key={item.key}
                    className="absolute left-0 top-0 grid w-full border-b border-border/40 hover:bg-accent/40"
                    style={{
                      gridTemplateColumns: gridTemplate,
                      height: ROW_HEIGHT,
                      transform: `translateY(${item.start}px)`
                    }}
                  >
                    {result.columns.map((_col, ci) => {
                      const { text, isNull } = formatCell(row?.[ci])
                      return (
                        <button
                          key={ci}
                          type="button"
                          onClick={() => copyCell(row?.[ci])}
                          title={text}
                          className={`truncate border-r border-border/40 px-2 text-left ${
                            isNull ? 'italic text-muted-foreground/60' : ''
                          }`}
                        >
                          {text}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {translate('auto.components.database.ResultsGrid.rowCount', '{{count}} rows', {
            count: result.rowCount
          })}
        </span>
        <span>
          {translate('auto.components.database.ResultsGrid.durationMs', '{{ms}} ms', {
            ms: result.durationMs
          })}
        </span>
        {refine?.refine.engaged ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={refine.refine.offset === 0}
              onClick={() => refine.onPage(-1)}
            >
              <ChevronLeft className="size-3.5" />
              <span className="sr-only">
                {translate('auto.components.database.ResultsGrid.prevPage', 'Previous page')}
              </span>
            </Button>
            <span className="tabular-nums">
              {translate('auto.components.database.ResultsGrid.pageRange', '{{from}}–{{to}}', {
                from: result.rowCount === 0 ? 0 : refine.refine.offset + 1,
                to: refine.refine.offset + result.rowCount
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!refine.refine.hasNext}
              onClick={() => refine.onPage(1)}
            >
              <ChevronRight className="size-3.5" />
              <span className="sr-only">
                {translate('auto.components.database.ResultsGrid.nextPage', 'Next page')}
              </span>
            </Button>
          </div>
        ) : result.truncated ? (
          <span className="text-amber-600 dark:text-amber-500">
            {translate(
              'auto.components.database.ResultsGrid.truncated',
              'Truncated — showing the first rows'
            )}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function GridPlaceholder({ text, spinning }: { text: string; spinning?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 p-6">
      {spinning ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  )
}
