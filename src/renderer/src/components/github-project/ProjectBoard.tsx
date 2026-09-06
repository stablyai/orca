import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import ProjectBoardCard from './ProjectBoardCard'
import { singleSelectChipColors } from './project-cell-chip-colors'
import {
  buildBoardColumns,
  resolveBoardColumnField,
  type ProjectBoardColumn
} from '../../../../shared/github/project-board-columns'
import { sortRows } from '../../../../shared/github/project-group-sort'
import type {
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github/project-types'

const COLUMN_WIDTH_PX = 272
const CARD_DRAG_MIME = 'application/x-orca-project-row'

type Props = {
  table: GitHubProjectTable
  onOpenDialog?: (row: GitHubProjectRow) => void
  onEditField?: (
    row: GitHubProjectRow,
    fieldId: string,
    value: GitHubProjectFieldMutationValue | null
  ) => void
  /** Rendered instead of the board when no column field is resolvable — the
   *  caller supplies the table list so the items stay usable. */
  fallback: React.ReactNode
}

export default function ProjectBoard({
  table,
  onOpenDialog,
  onEditField,
  fallback
}: Props): React.JSX.Element {
  const field = useMemo(() => resolveBoardColumnField(table.selectedView), [table.selectedView])
  const columns = useMemo(
    () => (field ? buildBoardColumns(field, sortRows(table, table.rows)) : []),
    [field, table]
  )
  const rowsById = useMemo(() => new Map(table.rows.map((row) => [row.id, row])), [table.rows])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const fieldId = field?.id ?? null
  const moveRow = useCallback(
    (rowId: string, column: ProjectBoardColumn): void => {
      const row = rowsById.get(rowId)
      // Why: dropValue undefined marks a column with nothing valid to mutate
      // into (deleted option, users/labels bucket) — the drop is simply inert.
      if (!row || fieldId === null || column.dropValue === undefined) {
        return
      }
      const current = row.fieldValuesByFieldId[fieldId]
      const drop = column.dropValue
      const alreadyThere =
        drop === null
          ? current === undefined
          : drop.kind === 'single-select'
            ? current?.kind === 'single-select' && current.optionId === drop.optionId
            : drop.kind === 'iteration' &&
              current?.kind === 'iteration' &&
              current.iterationId === drop.iterationId
      if (!alreadyThere) {
        onEditField?.(row, fieldId, column.dropValue)
      }
    },
    [rowsById, fieldId, onEditField]
  )

  // Why: Orca's preload stops every native drop with stopPropagation before it
  // reaches React's root, so — like the workspace kanban — board drops must
  // commit from a document-level CAPTURE listener (same node as preload's, so
  // it still runs; React onDrop never would).
  useEffect(() => {
    const columnsByKey = new Map(columns.map((column) => [column.key, column]))
    const handleDocumentDrop = (event: DragEvent): void => {
      // Why: any drop ends the drag — clear the hover highlight even for
      // payload-less drops so no column is left stuck in its hover state.
      setDropTarget(null)
      const rowId = event.dataTransfer?.getData(CARD_DRAG_MIME)
      if (!rowId) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      const columnEl = target?.closest('[data-board-column-key]')
      if (!(columnEl instanceof HTMLElement) || !containerRef.current?.contains(columnEl)) {
        return
      }
      const column = columnsByKey.get(columnEl.dataset.boardColumnKey ?? '')
      if (!column) {
        return
      }
      event.preventDefault()
      moveRow(rowId, column)
    }
    document.addEventListener('drop', handleDocumentDrop, true)
    return () => document.removeEventListener('drop', handleDocumentDrop, true)
  }, [columns, moveRow])

  if (!field) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex-none border-b border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.github.project.ProjectBoard.61a5e74e8a',
            'This board view has no single-select or iteration field to group by, so Orca is listing items instead.'
          )}
        </div>
        {fallback}
      </div>
    )
  }

  if (table.rows.length === 0) {
    return (
      <div className="flex min-h-[120px] items-center justify-center p-6 text-sm text-muted-foreground">
        {translate(
          'auto.components.github.project.ProjectViewList.4f57d2e0b1',
          "No items match this view's filter."
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-3 scrollbar-sleek"
    >
      {columns.map((column) => (
        <BoardColumn
          key={column.key}
          column={column}
          highlighted={dropTarget === column.key}
          onOpenDialog={onOpenDialog}
          onDragEnter={() => {
            if (column.dropValue !== undefined) {
              setDropTarget(column.key)
            }
          }}
          onDragLeaveOrEnd={() =>
            setDropTarget((current) => (current === column.key ? null : current))
          }
          onClearDropTarget={() => setDropTarget(null)}
        />
      ))}
    </div>
  )
}

function BoardColumn({
  column,
  highlighted,
  onOpenDialog,
  onDragEnter,
  onDragLeaveOrEnd,
  onClearDropTarget
}: {
  column: ProjectBoardColumn
  highlighted: boolean
  onOpenDialog?: (row: GitHubProjectRow) => void
  onDragEnter: () => void
  onDragLeaveOrEnd: () => void
  onClearDropTarget: () => void
}): React.JSX.Element {
  const colors = column.color ? singleSelectChipColors(column.color) : null
  return (
    <div
      role="list"
      aria-label={column.label}
      data-testid={`board-column-${column.key}`}
      data-board-column-key={column.key}
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col rounded-lg border bg-muted/20',
        highlighted && column.dropValue !== undefined
          ? 'border-ring/60 bg-accent/40'
          : 'border-border/50'
      )}
      style={{ width: COLUMN_WIDTH_PX }}
      onDragOver={(event) => {
        if (column.dropValue !== undefined && event.dataTransfer.types.includes(CARD_DRAG_MIME)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          onDragEnter()
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDragLeaveOrEnd()
        }
      }}
    >
      <div className="flex flex-none items-center gap-1.5 px-2.5 py-2 text-xs">
        {colors ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: colors.fgLight, boxShadow: `0 0 0 3px ${colors.bg}` }}
          />
        ) : null}
        <span className="truncate font-medium">{column.label}</span>
        <span className="rounded-full border border-border/50 bg-background px-1.5 text-[10px] text-muted-foreground">
          {column.rows.length}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2 scrollbar-sleek">
        {column.rows.map((row) => (
          <ProjectBoardCard
            key={row.id}
            row={row}
            draggable={row.itemType !== 'REDACTED'}
            onOpenDialog={() => onOpenDialog?.(row)}
            onDragStart={(event) => {
              event.dataTransfer.setData(CARD_DRAG_MIME, row.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            // Why: a cancelled drag (Esc, drop outside any column) fires no
            // drop event anywhere — dragend is the only reliable cleanup hook.
            onDragEnd={onClearDropTarget}
          />
        ))}
      </div>
    </div>
  )
}
