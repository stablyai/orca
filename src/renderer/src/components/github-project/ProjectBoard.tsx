import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import ProjectGroupHeader from './ProjectGroupHeader'
import { ProjectItemsEmptyState } from './ProjectViewStates'
import { boardCardFields, boardCardShowsAssignees } from './ProjectBoardCardFields'
import {
  BOARD_CARD_DRAG_MIME,
  BOARD_COLUMN_WIDTH_PX,
  BoardCardList,
  BoardColumnHeader,
  BoardDropTarget,
  type BoardCardOptions
} from './ProjectBoardColumn'
import {
  boardColumnsForLane,
  boardSwimlaneDropValue,
  buildBoardColumns,
  fieldValueMatchesDrop,
  resolveBoardColumnField,
  resolveBoardSwimlaneField,
  type ProjectBoardColumn
} from '../../../../shared/github/project-board-columns'
import {
  EMPTY_PROJECT_GROUP_KEY,
  groupRowsByField,
  sortRows,
  type ProjectGroup
} from '../../../../shared/github/project-group-sort'
import type {
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github/project-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const BOARD_COLUMN_GAP_PX = 12

type Props = {
  table: GitHubProjectTable
  onOpenDialog?: (row: GitHubProjectRow) => void
  onEditField?: (
    row: GitHubProjectRow,
    fieldId: string,
    value: GitHubProjectFieldMutationValue | null
  ) => void
  sourceTarget: RuntimeClientTarget
  /** Rendered instead of the board when no column field is resolvable — the
   *  caller supplies the table list so the items stay usable. */
  fallback: React.ReactNode
}

type DropCell = { column: ProjectBoardColumn; lane: ProjectGroup | null }
/** A lane key of null means the board has no swimlanes. */
type CellRef = { laneKey: string | null; columnKey: string }

export default function ProjectBoard({
  table,
  onOpenDialog,
  onEditField,
  sourceTarget,
  fallback
}: Props): React.JSX.Element {
  const view = table.selectedView
  const field = useMemo(() => resolveBoardColumnField(view), [view])
  const laneField = useMemo(() => resolveBoardSwimlaneField(view, field), [view, field])
  const sortedRows = useMemo(() => sortRows(table, table.rows), [table])
  const columns = useMemo(
    () => (field ? buildBoardColumns(field, sortedRows) : []),
    [field, sortedRows]
  )
  const lanes = useMemo(
    () =>
      laneField
        ? groupRowsByField(laneField, sortedRows).map((lane) => ({
            lane,
            columns: boardColumnsForLane(columns, lane.rows)
          }))
        : null,
    [laneField, sortedRows, columns]
  )
  const rowsById = useMemo(() => new Map(table.rows.map((row) => [row.id, row])), [table.rows])
  const [dropTarget, setDropTarget] = useState<CellRef | null>(null)
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(() => new Set())
  const containerRef = useRef<HTMLDivElement | null>(null)

  const fieldId = field?.id ?? null
  const moveRow = useCallback(
    (rowId: string, { column, lane }: DropCell): void => {
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
      if (!fieldValueMatchesDrop(row.fieldValuesByFieldId[fieldId], column.dropValue)) {
        onEditField?.(row, fieldId, column.dropValue)
      }
      if (!lane || !laneField || lane.rows.some((laneRow) => laneRow.id === rowId)) {
        return
      }
      // Lanes keyed by assignees or free text can't be written through a field mutation.
      const laneDrop = boardSwimlaneDropValue(laneField, lane.key)
      if (laneDrop !== undefined) {
        onEditField?.(row, laneField.id, laneDrop)
      }
    },
    [rowsById, fieldId, laneField, onEditField]
  )

  // Preload stops bubbling drops; commit from capture on the same document.
  useEffect(() => {
    const cells = new Map<string | null, Map<string, DropCell>>()
    for (const { lane, columns: laneColumns } of lanes ?? [{ lane: null, columns }]) {
      cells.set(
        lane?.key ?? null,
        new Map(laneColumns.map((column) => [column.key, { column, lane }]))
      )
    }
    const handleDocumentDrop = (event: DragEvent): void => {
      setDropTarget(null)
      const rowId = event.dataTransfer?.getData(BOARD_CARD_DRAG_MIME)
      if (!rowId) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      const cellEl = target?.closest('[data-board-column-key]')
      if (!(cellEl instanceof HTMLElement) || !containerRef.current?.contains(cellEl)) {
        return
      }
      const cell = cells
        .get(cellEl.dataset.boardLaneKey ?? null)
        ?.get(cellEl.dataset.boardColumnKey ?? '')
      if (!cell) {
        return
      }
      event.preventDefault()
      moveRow(rowId, cell)
    }
    // Esc and drops outside the board still clear the hover state.
    const handleDocumentDragEnd = (): void => setDropTarget(null)
    document.addEventListener('drop', handleDocumentDrop, true)
    document.addEventListener('dragend', handleDocumentDragEnd, true)
    return () => {
      document.removeEventListener('drop', handleDocumentDrop, true)
      document.removeEventListener('dragend', handleDocumentDragEnd, true)
    }
  }, [columns, lanes, moveRow])

  const cardOptions = useMemo<BoardCardOptions>(
    () => ({
      fields: boardCardFields(
        view,
        new Set([field?.id, laneField?.id].filter((id): id is string => Boolean(id)))
      ),
      showAssignees: boardCardShowsAssignees(view),
      draggable: Boolean(onEditField),
      sourceHost: table.project.host,
      sourceTarget,
      onOpenDialog
    }),
    [view, field, laneField, onEditField, table.project.host, sourceTarget, onOpenDialog]
  )

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

  const labelColumn = (column: ProjectBoardColumn): ProjectBoardColumn =>
    column.key === EMPTY_PROJECT_GROUP_KEY
      ? {
          ...column,
          label: translate('projectBoard.noField', 'No {{field}}', {
            field: field.name
          })
        }
      : column
  const dropHandlers = (laneKey: string | null, column: ProjectBoardColumn) => {
    const isThisCell = (cell: CellRef | null): boolean =>
      cell?.laneKey === laneKey && cell.columnKey === column.key
    return {
      laneKey,
      highlighted: isThisCell(dropTarget),
      onDragEnter: () => {
        if (column.dropValue !== undefined && !isThisCell(dropTarget)) {
          setDropTarget({ laneKey, columnKey: column.key })
        }
      },
      onDragLeaveOrEnd: () => setDropTarget((current) => (isThisCell(current) ? null : current))
    }
  }

  if (!lanes) {
    return (
      <div
        ref={containerRef}
        className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-3 scrollbar-sleek"
      >
        {columns.map((rawColumn) => {
          const column = labelColumn(rawColumn)
          return (
            <BoardDropTarget
              key={column.key}
              column={column}
              testId={`board-column-${column.key}`}
              ariaLabel={column.label}
              fillHeight
              {...dropHandlers(null, column)}
            >
              <BoardColumnHeader column={column} count={column.rows.length} />
              <BoardCardList rows={column.rows} scrolls options={cardOptions} />
            </BoardDropTarget>
          )
        })}
      </div>
    )
  }

  const bandWidth =
    columns.length * BOARD_COLUMN_WIDTH_PX + Math.max(0, columns.length - 1) * BOARD_COLUMN_GAP_PX
  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-3 pb-3 scrollbar-sleek"
    >
      <div className="sticky top-0 z-10 flex w-max min-w-full gap-3 bg-background pt-3">
        {columns.map((rawColumn) => (
          <div key={rawColumn.key} className="shrink-0" style={{ width: BOARD_COLUMN_WIDTH_PX }}>
            <BoardColumnHeader column={labelColumn(rawColumn)} count={rawColumn.rows.length} />
          </div>
        ))}
      </div>
      {lanes.map(({ lane, columns: laneColumns }) => {
        const expanded = !collapsedLanes.has(lane.key)
        return (
          <section
            key={lane.key}
            data-testid={`board-lane-${lane.key}`}
            className="w-max min-w-full"
          >
            <ProjectGroupHeader
              group={
                lane.key === EMPTY_PROJECT_GROUP_KEY
                  ? {
                      ...lane,
                      label: translate('projectBoard.noField', 'No {{field}}', {
                        field: laneField?.name ?? ''
                      })
                    }
                  : lane
              }
              expanded={expanded}
              bandWidth={bandWidth}
              onToggle={() =>
                setCollapsedLanes((previous) => {
                  const next = new Set(previous)
                  if (!next.delete(lane.key)) {
                    next.add(lane.key)
                  }
                  return next
                })
              }
            />
            {expanded ? (
              <div className="flex gap-3 py-2">
                {laneColumns.map((rawColumn) => {
                  const column = labelColumn(rawColumn)
                  return (
                    <BoardDropTarget
                      key={column.key}
                      column={column}
                      testId={`board-cell-${lane.key}-${column.key}`}
                      ariaLabel={`${lane.label || laneField?.name || ''} · ${column.label}`}
                      fillHeight={false}
                      {...dropHandlers(lane.key, column)}
                    >
                      <BoardCardList rows={column.rows} scrolls={false} options={cardOptions} />
                    </BoardDropTarget>
                  )
                })}
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
