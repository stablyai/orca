import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import ProjectBoardCard from './ProjectBoardCard'
import { ProjectItemsEmptyState } from './ProjectViewStates'
import { chipStyle, singleSelectChipColors } from './project-cell-chip-colors'
import {
  buildBoardColumns,
  resolveBoardColumnField,
  type ProjectBoardColumn
} from '../../../../shared/github/project-board-columns'
import { EMPTY_PROJECT_GROUP_KEY, sortRows } from '../../../../shared/github/project-group-sort'
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
      // Deleted options and read-only buckets have no valid mutation target.
      if (
        !row ||
        row.itemType === 'REDACTED' ||
        fieldId === null ||
        column.dropValue === undefined
      ) {
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

  // Preload stops bubbling drops; commit from capture on the same document.
  useEffect(() => {
    const columnsByKey = new Map(columns.map((column) => [column.key, column]))
    const handleDocumentDrop = (event: DragEvent): void => {
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
    // Esc and drops outside the board still clear the hover state.
    const handleDocumentDragEnd = (): void => setDropTarget(null)
    document.addEventListener('drop', handleDocumentDrop, true)
    document.addEventListener('dragend', handleDocumentDragEnd, true)
    return () => {
      document.removeEventListener('drop', handleDocumentDrop, true)
      document.removeEventListener('dragend', handleDocumentDragEnd, true)
    }
  }, [columns, moveRow])

  if (!field) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex-none border-b border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'projectBoard.noColumnField',
            'This board view has no single-select or iteration field to group by, so Orca is listing items instead.'
          )}
        </div>
        {fallback}
      </div>
    )
  }

  if (table.rows.length === 0) {
    return <ProjectItemsEmptyState filter={table.selectedView.filter} />
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-3 scrollbar-sleek"
    >
      {columns.map((column) => (
        <BoardColumn
          key={column.key}
          column={
            column.key === EMPTY_PROJECT_GROUP_KEY
              ? {
                  ...column,
                  label: translate('projectBoard.noField', 'No {{field}}', { field: field.name })
                }
              : column
          }
          highlighted={dropTarget === column.key}
          onOpenDialog={onOpenDialog}
          onEditField={onEditField}
          onDragEnter={() => {
            if (column.dropValue !== undefined) {
              setDropTarget(column.key)
            }
          }}
          onDragLeaveOrEnd={() =>
            setDropTarget((current) => (current === column.key ? null : current))
          }
        />
      ))}
    </div>
  )
}

function BoardColumn({
  column,
  highlighted,
  onOpenDialog,
  onEditField,
  onDragEnter,
  onDragLeaveOrEnd
}: {
  column: ProjectBoardColumn
  highlighted: boolean
  onOpenDialog?: (row: GitHubProjectRow) => void
  onEditField?: Props['onEditField']
  onDragEnter: () => void
  onDragLeaveOrEnd: () => void
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
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          onDragLeaveOrEnd()
        }
      }}
    >
      <div className="flex flex-none items-center gap-1.5 px-2.5 py-2 text-xs">
        {colors ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-[var(--github-project-chip-fg-light)] dark:bg-[var(--github-project-chip-fg-dark)]"
            style={{
              ...chipStyle(colors),
              boxShadow: `0 0 0 3px ${colors.bg}`
            }}
          />
        ) : null}
        <span className="truncate font-medium">{column.label}</span>
        <span className="rounded-full border border-border/50 bg-background px-1.5 text-[11px] text-muted-foreground">
          {column.rows.length}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2 scrollbar-sleek">
        {column.rows.map((row) => (
          <ProjectBoardCard
            key={row.id}
            row={row}
            draggable={Boolean(onEditField) && row.itemType !== 'REDACTED'}
            onOpenDialog={() => onOpenDialog?.(row)}
            onDragStart={(event) => {
              event.dataTransfer.setData(CARD_DRAG_MIME, row.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
          />
        ))}
      </div>
    </div>
  )
}
