import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { translate } from '@/i18n/i18n'
import type {
  DbColumn,
  DbColumnFilter,
  DbColumnSort,
  QueryResult
} from '../../../../shared/database-types'
import { DataGridColumnHeader } from './DataGridColumnHeader'
import { filterFor } from './data-grid-filters'
import { sortDirectionFor } from './data-grid-sort-state'
import { overlayCell, rowKeyFor, type DbEditBuffer } from './table-data-edit-buffer'
import { TableDataCell } from './TableDataCell'
import { TableDataRowMenu } from './TableDataRowMenu'

const ROW_HEIGHT = 26
const OVERSCAN = 16
const COL_MIN_PX = 120
const COL_MAX_PX = 320

// Row tints (staged state) via color-mix tokens — no new hex, adapts to theme.
const DELETED_ROW_STYLE: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--destructive) 14%, transparent)'
}
const NEW_ROW_STYLE: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--status-success, var(--primary)) 12%, transparent)'
}

export type TableDataGridEditHandlers = {
  editable: boolean
  keyColumns: string[]
  edit: DbEditBuffer
  onEditCell: (rowKey: string, column: string, value: unknown, original: unknown) => void
  onEditNewCell: (tempId: string, column: string, value: unknown) => void
  onToggleDelete: (rowKey: string) => void
  onDiscardNew: (tempId: string) => void
}

// Virtualized, editable CSS-grid for one page of table rows. Existing rows are
// virtualized; staged new rows render below them. Read-only when `editable` is
// false (no PK / read-only connection) — cells then copy on click instead.
export function TableDataGrid({
  result,
  columns,
  sorts,
  filters,
  onSort,
  onFilter,
  edits
}: {
  result: QueryResult
  columns?: DbColumn[]
  sorts: DbColumnSort[]
  filters: DbColumnFilter[]
  onSort: (column: string) => void
  onFilter: (column: string, filter: DbColumnFilter | null) => void
  edits: TableDataGridEditHandlers
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = result.rows
  const columnNames = result.columns.map((c) => c.name)
  const deleted = new Set(edits.edit.deletes)
  const { editable } = edits

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => index
  })

  const meta = (name: string): DbColumn | undefined => columns?.find((c) => c.name === name)
  const gridTemplate =
    result.columns.length > 0
      ? result.columns.map(() => `minmax(${COL_MIN_PX}px, ${COL_MAX_PX}px)`).join(' ')
      : '1fr'

  return (
    <div ref={scrollRef} className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
      <div className="inline-block min-w-full font-mono text-xs">
        <div
          className="sticky top-0 z-10 grid border-b border-border bg-muted/90 backdrop-blur"
          style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
        >
          {result.columns.map((col, i) => (
            <DataGridColumnHeader
              key={`${col.name}-${i}`}
              name={col.name}
              dataType={meta(col.name)?.dataType ?? col.dataType}
              isPrimaryKey={meta(col.name)?.isPrimaryKey}
              sortDirection={sortDirectionFor(sorts, col.name)}
              onSort={() => onSort(col.name)}
              filter={filterFor(filters, col.name)}
              onFilter={(filter) => onFilter(col.name, filter)}
            />
          ))}
        </div>

        {rows.length === 0 && edits.edit.inserts.length === 0 ? (
          <div className="px-2 py-2 text-muted-foreground">
            {translate('auto.components.database.TableDataGrid.noRows', 'No rows')}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              const rowKey = editable ? rowKeyFor(edits.keyColumns, columnNames, row) : ''
              const isDeleted = editable && deleted.has(rowKey)
              return (
                <TableDataRowMenu
                  key={item.key}
                  actions={
                    editable
                      ? [
                          isDeleted
                            ? {
                                label: translate('auto.components.database.TableDataGrid.restoreRow', 'Restore row'),
                                onSelect: () => edits.onToggleDelete(rowKey)
                              }
                            : {
                                label: translate('auto.components.database.TableDataGrid.deleteRow', 'Delete row'),
                                destructive: true,
                                onSelect: () => edits.onToggleDelete(rowKey)
                              }
                        ]
                      : []
                  }
                >
                  <div
                    className={`absolute left-0 top-0 grid w-full border-b border-border/40 hover:bg-accent/40 ${
                      isDeleted ? 'line-through opacity-60' : ''
                    }`}
                    style={{
                      gridTemplateColumns: gridTemplate,
                      height: ROW_HEIGHT,
                      transform: `translateY(${item.start}px)`,
                      ...(isDeleted ? DELETED_ROW_STYLE : undefined)
                    }}
                  >
                    {result.columns.map((col, ci) => {
                      const original = row?.[ci]
                      const { value, hasEdit } = editable
                        ? overlayCell(edits.edit, rowKey, col.name, original)
                        : { value: original, hasEdit: false }
                      return (
                        <TableDataCell
                          key={ci}
                          value={value}
                          dirty={hasEdit}
                          editable={editable && !isDeleted}
                          onCommit={(next) => edits.onEditCell(rowKey, col.name, next, original)}
                        />
                      )
                    })}
                  </div>
                </TableDataRowMenu>
              )
            })}
          </div>
        )}

        {/* Staged new rows render below the existing page. */}
        {edits.edit.inserts.map((newRow) => (
          <TableDataRowMenu
            key={newRow.tempId}
            actions={[
              {
                label: translate('auto.components.database.TableDataGrid.discardRow', 'Discard row'),
                destructive: true,
                onSelect: () => edits.onDiscardNew(newRow.tempId)
              }
            ]}
          >
            <div
              className="grid w-full border-b border-border/40"
              style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT, ...NEW_ROW_STYLE }}
            >
              {result.columns.map((col, ci) => {
                const has = col.name in newRow.values
                return (
                  <TableDataCell
                    key={ci}
                    value={has ? newRow.values[col.name] : null}
                    dirty={has}
                    editable
                    onCommit={(next) => edits.onEditNewCell(newRow.tempId, col.name, next)}
                  />
                )
              })}
            </div>
          </TableDataRowMenu>
        ))}
      </div>
    </div>
  )
}
