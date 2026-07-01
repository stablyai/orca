import React, { useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Undo2,
  X
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { DbColumnFilter } from '../../../../shared/database-types'
import { setColumnFilter } from './data-grid-filters'
import { bufferChangeCount } from './table-data-edit-buffer'
import { TableDataGrid, type TableDataGridEditHandlers } from './TableDataGrid'

// A table's Data tab: server-side sort/filter/pagination with staged cell/row
// editing. Editing is enabled only when the table has a primary key AND the
// connection is writable; otherwise it stays a read-only browser.
export function TableDataView({
  connectionId,
  tabId
}: {
  connectionId: string
  tabId: string
}): React.JSX.Element {
  const view = useAppStore((s) => s.dbTableData[connectionId]?.[tabId])
  const columns = useAppStore((s) => s.dbSchemaCache[connectionId]?.columns[tabId])
  const readOnly = useAppStore(
    (s) => s.dbConnections.find((c) => c.id === connectionId)?.readOnly ?? true
  )
  const setDbTableSort = useAppStore((s) => s.setDbTableSort)
  const setDbTableFilters = useAppStore((s) => s.setDbTableFilters)
  const setDbTablePage = useAppStore((s) => s.setDbTablePage)
  const loadDbTableData = useAppStore((s) => s.loadDbTableData)
  const loadDbTableCount = useAppStore((s) => s.loadDbTableCount)
  const stageDbCellEdit = useAppStore((s) => s.stageDbCellEdit)
  const editDbNewRowCell = useAppStore((s) => s.editDbNewRowCell)
  const toggleDbDeleteRow = useAppStore((s) => s.toggleDbDeleteRow)
  const discardDbNewRow = useAppStore((s) => s.discardDbNewRow)
  const addDbNewRow = useAppStore((s) => s.addDbNewRow)
  const revertDbEdits = useAppStore((s) => s.revertDbEdits)
  const saveDbEdits = useAppStore((s) => s.saveDbEdits)

  const [saving, setSaving] = useState(false)

  if (!view) {
    return <ViewPlaceholder text={translate('auto.components.database.TableDataView.closed', 'Tab closed')} />
  }

  const keyColumns = (columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name)
  const hasPrimaryKey = keyColumns.length > 0
  const editable = hasPrimaryKey && !readOnly
  const dirtyCount = bufferChangeCount(view.edit)
  const dirty = dirtyCount > 0

  const result = view.result
  const rowCount = result?.rows.length ?? 0
  const from = rowCount === 0 ? 0 : view.offset + 1
  const to = view.offset + rowCount

  const applyFilter = (column: string, filter: DbColumnFilter | null): void => {
    setDbTableFilters(connectionId, tabId, setColumnFilter(view.filters, column, filter))
  }

  const edits: TableDataGridEditHandlers = {
    editable,
    keyColumns,
    edit: view.edit,
    onEditCell: (rowKey, column, value, original) =>
      stageDbCellEdit(connectionId, tabId, rowKey, column, value, original),
    onEditNewCell: (tempId, column, value) =>
      editDbNewRowCell(connectionId, tabId, tempId, column, value),
    onToggleDelete: (rowKey) => toggleDbDeleteRow(connectionId, tabId, rowKey),
    onDiscardNew: (tempId) => discardDbNewRow(connectionId, tabId, tempId)
  }

  const onSave = async (): Promise<void> => {
    setSaving(true)
    await saveDbEdits(connectionId, tabId)
    setSaving(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={dirty || view.loading}
          onClick={() => void loadDbTableData(connectionId, tabId)}
          title={translate('auto.components.database.TableDataView.refresh', 'Refresh')}
        >
          <RefreshCw className={`size-3.5 ${view.loading ? 'animate-spin' : ''}`} />
          <span className="sr-only">
            {translate('auto.components.database.TableDataView.refresh', 'Refresh')}
          </span>
        </Button>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {view.schema}.{view.table}
        </span>
        {view.filters.length > 0 ? (
          <Badge variant="outline" className="h-5 gap-1 text-[10px]">
            {translate('auto.components.database.TableDataView.filterCount', '{{count}} filter', {
              count: view.filters.length
            })}
            <button
              type="button"
              disabled={dirty}
              onClick={() => setDbTableFilters(connectionId, tabId, [])}
              aria-label={translate('auto.components.database.TableDataView.clearFilters', 'Clear filters')}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ) : null}
        {!editable ? (
          <Badge variant="outline" className="h-5 gap-1 text-[10px] text-muted-foreground">
            <Lock className="size-2.5" />
            {readOnly
              ? translate('auto.components.database.TableDataView.readOnlyConn', 'Read-only')
              : translate('auto.components.database.TableDataView.noPrimaryKey', 'No primary key')}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {editable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-xs"
              onClick={() => addDbNewRow(connectionId, tabId)}
            >
              <Plus className="size-3" />
              {translate('auto.components.database.TableDataView.addRow', 'Add row')}
            </Button>
          ) : null}
          {dirty ? (
            <>
              {view.saveError ? (
                <span className="max-w-[180px] truncate text-[10px] text-destructive">
                  {view.saveError.safeMessage}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 text-xs"
                disabled={saving}
                onClick={() => revertDbEdits(connectionId, tabId)}
              >
                <Undo2 className="size-3" />
                {translate('auto.components.database.TableDataView.revert', 'Revert')}
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-6 gap-1 text-xs"
                disabled={saving}
                onClick={() => void onSave()}
              >
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                {translate('auto.components.database.TableDataView.save', 'Save {{count}}', {
                  count: dirtyCount
                })}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {view.error ? (
        <ViewPlaceholder text={view.error.safeMessage} tone="error" />
      ) : !result ? (
        <ViewPlaceholder
          text={translate('auto.components.database.TableDataView.loading', 'Loading…')}
          spinning
        />
      ) : (
        <TableDataGrid
          result={result}
          columns={columns}
          sorts={view.sorts}
          filters={view.filters}
          // Sorting/filtering re-queries and drops staged edits, so lock it while dirty.
          onSort={(column) => !dirty && setDbTableSort(connectionId, tabId, column)}
          onFilter={(column, filter) => !dirty && applyFilter(column, filter)}
          edits={edits}
        />
      )}

      <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={view.offset === 0 || view.loading || dirty}
            onClick={() => setDbTablePage(connectionId, tabId, -1)}
          >
            <ChevronLeft className="size-3.5" />
            <span className="sr-only">
              {translate('auto.components.database.TableDataView.prevPage', 'Previous page')}
            </span>
          </Button>
          <span className="tabular-nums">
            {translate('auto.components.database.TableDataView.range', '{{from}}–{{to}}', { from, to })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!view.hasNext || view.loading || dirty}
            onClick={() => setDbTablePage(connectionId, tabId, 1)}
          >
            <ChevronRight className="size-3.5" />
            <span className="sr-only">
              {translate('auto.components.database.TableDataView.nextPage', 'Next page')}
            </span>
          </Button>
        </div>
        {view.totalCount != null ? (
          <span className="tabular-nums">
            {translate('auto.components.database.TableDataView.ofTotal', 'of {{total}}', {
              total: view.totalCount
            })}
          </span>
        ) : (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => void loadDbTableCount(connectionId, tabId)}
          >
            {translate('auto.components.database.TableDataView.countRows', 'Count rows')}
          </button>
        )}
        {dirty ? (
          <span className="text-amber-600 dark:text-amber-500">
            {translate(
              'auto.components.database.TableDataView.unsavedHint',
              'Unsaved edits — save or revert to sort, filter, or page'
            )}
          </span>
        ) : null}
        {view.loading ? <Loader2 className="size-3 animate-spin" /> : null}
      </div>
    </div>
  )
}

function ViewPlaceholder({
  text,
  spinning,
  tone
}: {
  text: string
  spinning?: boolean
  tone?: 'error'
}): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 p-6">
      {spinning ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      <p className={`text-xs ${tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
        {text}
      </p>
    </div>
  )
}
