import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SqliteCell, SqliteDatabaseOverview } from '../../../../shared/sqlite-database'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useSqliteTableRows } from './use-sqlite-table-rows'
import SqliteTableList from './SqliteTableList'
import type { SqliteFileOwner } from './sqlite-file-owner'

type SqliteViewerProps = {
  filePath: string
  owner: SqliteFileOwner
}

function ownerBlockedMessage(owner: SqliteFileOwner): string | null {
  if (owner.kind === 'remote') {
    return translate(
      'auto.components.editor.SqliteViewer.remoteUnsupported',
      'Opening SQLite databases on SSH hosts is not supported yet. Copy the file locally to inspect it.'
    )
  }
  if (owner.kind === 'runtime-environment') {
    return translate(
      'auto.components.editor.SqliteViewer.runtimeUnsupported',
      'Opening SQLite databases in a remote runtime environment is not supported yet.'
    )
  }
  if (owner.kind === 'unresolved') {
    return translate(
      'auto.components.editor.SqliteViewer.ownerUnresolved',
      'Still determining which host owns this file. Reopen the tab once the connection is ready.'
    )
  }
  return null
}

const ROW_HEIGHT = 28
const OVERSCAN = 12
const MIN_COL_PX = 96
const MAX_COL_PX = 320
const ROW_NUMBER_COL_PX = 56
const CHAR_PX = 7

// NULL must stay visibly distinct from an empty string; they are different values in SQL.
function cellClassName(cell: SqliteCell | undefined): string {
  if (cell === undefined) {
    return 'text-muted-foreground/40'
  }
  if (cell.type === 'null') {
    return 'italic text-muted-foreground/70'
  }
  if (cell.type === 'blob') {
    return 'italic text-muted-foreground'
  }
  return cell.type === 'integer' || cell.type === 'real'
    ? 'justify-end tabular-nums text-foreground'
    : 'text-foreground'
}

function cellText(cell: SqliteCell | undefined): string {
  if (cell === undefined) {
    return ''
  }
  return cell.type === 'null' ? 'NULL' : cell.text
}

export default function SqliteViewer({ filePath, owner }: SqliteViewerProps): React.JSX.Element {
  const blocked = ownerBlockedMessage(owner)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overview, setOverview] = useState<SqliteDatabaseOverview | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)

  useEffect(() => {
    if (blocked !== null) {
      return
    }
    let cancelled = false
    setOverview(null)
    setOpenError(null)
    void window.api.sqlite
      .openDatabase({ filePath })
      .then((result) => {
        if (cancelled) {
          return
        }
        setOverview(result)
        setSelectedTable(result.tables[0]?.name ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOpenError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [filePath, blocked])

  const activeTable = overview?.tables.find((table) => table.name === selectedTable) ?? null
  const countable = activeTable !== null
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [countError, setCountError] = useState<string | null>(null)

  // count(*) scans, so only the displayed table is counted, not every table on open.
  useEffect(() => {
    if (!countable || selectedTable === null) {
      setRowCount(null)
      return
    }
    let cancelled = false
    setRowCount(null)
    setCountError(null)
    void window.api.sqlite
      .countTableRows({ filePath, table: selectedTable })
      .then((count) => {
        if (!cancelled) {
          setRowCount(count)
        }
      })
      .catch((err: unknown) => {
        // Zero here would render a broken table as a valid empty one.
        if (!cancelled) {
          setCountError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [filePath, selectedTable, countable])
  const { getRow, ensureRange, columns, error } = useSqliteTableRows(
    filePath,
    countable ? selectedTable : null,
    rowCount ?? 0
  )

  const headerColumns = columns.length > 0 ? columns : (activeTable?.columns ?? [])

  const columnWidths = useMemo(
    () =>
      headerColumns.map((name) =>
        Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, name.length * CHAR_PX + 32))
      ),
    [headerColumns]
  )
  const gridTemplate = useMemo(
    () => `${ROW_NUMBER_COL_PX}px ${columnWidths.map((w) => `${w}px`).join(' ')}`,
    [columnWidths]
  )

  const virtualizer = useVirtualizer({
    count: rowCount ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => index
  })
  const virtualRows = virtualizer.getVirtualItems()

  useEffect(() => {
    const first = virtualRows[0]
    const last = virtualRows.at(-1)
    if (first !== undefined && last !== undefined) {
      ensureRange(first.index, last.index)
    }
  }, [virtualRows, ensureRange])

  if (blocked !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {blocked}
      </div>
    )
  }
  if (openError !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {openError}
      </div>
    )
  }
  if (overview === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('auto.components.editor.SqliteViewer.loading', 'Reading database…')}
      </div>
    )
  }
  if (overview.tables.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('auto.components.editor.SqliteViewer.noTables', 'This database has no tables')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <SqliteTableList
        tables={overview.tables}
        selectedTable={selectedTable}
        onSelect={setSelectedTable}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {countError !== null ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-destructive">
            {countError}
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="relative min-h-0 flex-1 overflow-auto scrollbar-editor font-mono text-xs"
          >
            <div
              role="table"
              aria-rowcount={(rowCount ?? 0) + 1}
              aria-colcount={headerColumns.length + 1}
              className="inline-block min-w-full"
              style={{ width: 'max-content' }}
            >
              <div
                role="row"
                aria-rowindex={1}
                className="sticky top-0 z-10 grid bg-muted/90 backdrop-blur"
                style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
              >
                <div
                  role="columnheader"
                  className="sticky left-0 z-20 flex items-center justify-end border-b border-r border-border/60 bg-muted/90 px-2 text-[10px] font-normal text-muted-foreground"
                >
                  #
                </div>
                {headerColumns.map((name, idx) => (
                  <div
                    role="columnheader"
                    key={idx}
                    className="flex items-center overflow-hidden border-b border-r border-border/60 px-2 font-medium text-foreground"
                  >
                    <span className="truncate" title={name}>
                      {name}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualRows.map((vr) => {
                  const row = getRow(vr.index)
                  return (
                    <div
                      role="row"
                      aria-rowindex={vr.index + 2}
                      key={vr.key}
                      data-index={vr.index}
                      className="group grid hover:bg-accent/40"
                      style={{
                        gridTemplateColumns: gridTemplate,
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        height: ROW_HEIGHT,
                        transform: `translateY(${vr.start}px)`
                      }}
                    >
                      <div
                        role="rowheader"
                        className="sticky left-0 z-[5] flex items-center justify-end border-b border-r border-border/40 bg-background/95 px-2 text-[10px] text-muted-foreground group-hover:bg-accent/40"
                      >
                        {vr.index + 1}
                      </div>
                      {headerColumns.map((_, colIdx) => {
                        const cell = row?.[colIdx]
                        return (
                          <div
                            role="cell"
                            key={colIdx}
                            className={cn(
                              'flex items-center overflow-hidden border-b border-r border-border/40 px-2',
                              cellClassName(cell)
                            )}
                            title={cell?.truncated === true ? `${cell.text}…` : cellText(cell)}
                          >
                            <span className="truncate">{cellText(cell)}</span>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-4 border-t border-border/60 px-3 py-1 text-xs text-muted-foreground">
          <span>{selectedTable}</span>
          <span>
            {rowCount === null
              ? translate('auto.components.editor.SqliteViewer.counting', 'counting rows…')
              : `${rowCount.toLocaleString()} ${translate('auto.components.editor.SqliteViewer.rows', 'rows')}`}
          </span>
          <span>
            {headerColumns.length}{' '}
            {translate('auto.components.editor.SqliteViewer.columns', 'columns')}
          </span>
          {error !== null && <span className="text-destructive">{error}</span>}
        </div>
      </div>
    </div>
  )
}
