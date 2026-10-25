import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { csvSelectionBounds, type CsvCellSelection } from './csv-cell-selection'
import type { CsvTableMutation } from './csv-text-document'
import type { CsvInspectionSort } from './csv-inspection'

export function CsvTableToolbar({
  selection,
  getSelectedRows,
  sourceRow,
  sourceRowCount,
  columnCount,
  filter,
  sort,
  saving,
  canEdit,
  canSave,
  onFilter,
  onSort,
  onApply,
  onEdit,
  onSave,
  onCopy,
  onPaste
}: {
  selection: CsvCellSelection | null
  getSelectedRows: () => number[]
  sourceRow: number
  sourceRowCount: number
  columnCount: number
  filter: string
  sort: CsvInspectionSort | null
  saving: boolean
  canEdit: boolean
  canSave: boolean
  onFilter: (value: string) => void
  onSort: (value: CsvInspectionSort | null) => void
  onApply: (mutation: CsvTableMutation) => boolean
  onEdit: () => void
  onSave: () => void
  onCopy: () => void
  onPaste: () => void
}): React.JSX.Element {
  const column = selection?.focus.column ?? 0
  const row = Math.max(1, sourceRow)
  const blankRow = () => Array.from({ length: columnCount }, () => '')
  const selectedColumns = selection ? csvSelectionBounds(selection) : null
  const deleteColumns = () =>
    selectedColumns
      ? Array.from(
          { length: selectedColumns.lastColumn - selectedColumns.firstColumn + 1 },
          (_, offset) => selectedColumns.firstColumn + offset
        )
      : []
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <div className="min-w-0 flex-1 max-w-xs">
        <Input
          aria-label={translate('csv.filterRows', 'Filter rows')}
          placeholder={translate('csv.filterRows', 'Filter rows')}
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
        />
      </div>
      <Button variant="ghost" size="xs" disabled={!selection || !canEdit} onClick={onEdit}>
        {translate('csv.edit', 'Edit cell')}
      </Button>
      <Button variant="ghost" size="xs" disabled={!selection} onClick={onCopy}>
        {translate('csv.copy', 'Copy')}
      </Button>
      <Button variant="ghost" size="xs" disabled={!selection || !canEdit} onClick={onPaste}>
        {translate('csv.paste', 'Paste')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" disabled={!canEdit || !columnCount}>
            {translate('csv.rows', 'Rows')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onSelect={() => onApply({ kind: 'insert-rows', at: row, rows: [blankRow()] })}
          >
            {translate('csv.insertRowAbove', 'Insert row above')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              onApply({
                kind: 'insert-rows',
                at: sourceRow === 0 ? 1 : Math.min(row + 1, sourceRowCount),
                rows: [blankRow()]
              })
            }
          >
            {translate('csv.insertRowBelow', 'Insert row below')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selection || csvSelectionBounds(selection).lastRow === 0}
            onSelect={() =>
              onApply({ kind: 'delete-rows', rows: getSelectedRows().filter((row) => row > 0) })
            }
          >
            {translate('csv.deleteRows', 'Delete selected rows')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" disabled={!canEdit}>
            {translate('csv.columns', 'Columns')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onSelect={() =>
              onApply({
                kind: 'insert-column',
                at: column,
                label: translate('csv.newColumn', 'Column {{column}}', { column: columnCount + 1 })
              })
            }
          >
            {translate('csv.insertColumnBefore', 'Insert column before')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              onApply({
                kind: 'insert-column',
                at: Math.min(columnCount, column + 1),
                label: translate('csv.newColumn', 'Column {{column}}', { column: columnCount + 1 })
              })
            }
          >
            {translate('csv.insertColumnAfter', 'Insert column after')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selection || column === 0}
            onSelect={() => onApply({ kind: 'move-column', from: column, to: column - 1 })}
          >
            {translate('csv.moveColumnLeft', 'Move column left')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selection || column >= columnCount - 1}
            onSelect={() => onApply({ kind: 'move-column', from: column, to: column + 1 })}
          >
            {translate('csv.moveColumnRight', 'Move column right')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selection}
            onSelect={() => onApply({ kind: 'delete-columns', columns: deleteColumns() })}
          >
            {translate('csv.deleteColumns', 'Delete selected columns')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" disabled={!columnCount}>
            {translate('csv.sort', 'Sort')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => onSort({ column, direction: 'ascending' })}>
            {translate('csv.sortAscending', 'Sort selected column ascending')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSort({ column, direction: 'descending' })}>
            {translate('csv.sortDescending', 'Sort selected column descending')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!sort} onSelect={() => onSort(null)}>
            {translate('csv.originalOrder', 'Original row order')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canSave && (
        <Button variant="outline" size="xs" disabled={saving} aria-busy={saving} onClick={onSave}>
          {translate('csv.save', 'Save')}
        </Button>
      )}
      {(filter || sort) && (
        <span className="text-xs text-muted-foreground">
          {translate('csv.inspectionOnly', 'Inspection only · File row order unchanged')}
        </span>
      )}
    </div>
  )
}
