// Why: GitHub Project board layout renders rows grouped by a SINGLE_SELECT field
// (typically Status) as horizontal columns with draggable cards, matching
// GitHub's native Board view behavior. All field options get a column (including
// empty ones) so the board mirrors the full workflow.
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { GitPullRequest, GripVertical, Lock, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sortRows } from '../../../../shared/github/project-group-sort'
import type {
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github/project-types'
import { translate } from '@/i18n/i18n'

type Props = {
  table: GitHubProjectTable
  onOpenDialog?: (row: GitHubProjectRow) => void
  onEditField?: (
    row: GitHubProjectRow,
    fieldId: string,
    value: GitHubProjectFieldMutationValue | null
  ) => void
}

type ColumnDef = {
  key: string
  label: string
  color: string
  rows: GitHubProjectRow[]
}

// ─── Helpers ───────────────────────────────────────────────────────────

function getGroupField(table: GitHubProjectTable): GitHubProjectField | null {
  const gf = table.selectedView.groupByFields[0] ?? null
  if (!gf || (gf.kind !== 'single-select' && gf.kind !== 'iteration')) {
    return null
  }
  return gf
}

function buildColumns(field: GitHubProjectField, sortedRows: GitHubProjectRow[]): ColumnDef[] {
  const columns: ColumnDef[] = []

  if (field.kind === 'single-select') {
    const bucket = new Map<string, GitHubProjectRow[]>()
    for (const opt of field.options) {
      bucket.set(opt.id, [])
    }
    const emptyRows: GitHubProjectRow[] = []
    for (const row of sortedRows) {
      const fv = row.fieldValuesByFieldId[field.id]
      if (fv?.kind === 'single-select' && bucket.has(fv.optionId)) {
        bucket.get(fv.optionId)!.push(row)
      } else {
        emptyRows.push(row)
      }
    }
    for (const opt of field.options) {
      columns.push({
        key: opt.id,
        label: opt.name,
        color: opt.color,
        rows: bucket.get(opt.id) ?? []
      })
    }
    if (emptyRows.length > 0) {
      columns.push({
        key: '__empty__',
        label: translate(
          'auto.components.github.project.ProjectViewKanban.56d805c8f8',
          'No {{value0}}',
          {
            value0: field.name
          }
        ),
        color: '',
        rows: emptyRows
      })
    }
    return columns
  }

  if (field.kind === 'iteration') {
    const bucket = new Map<string, GitHubProjectRow[]>()
    const emptyRows: GitHubProjectRow[] = []
    for (const row of sortedRows) {
      const fv = row.fieldValuesByFieldId[field.id]
      if (fv?.kind === 'iteration') {
        const existing = bucket.get(fv.iterationId)
        if (existing) {
          existing.push(row)
        } else {
          bucket.set(fv.iterationId, [row])
        }
      } else {
        emptyRows.push(row)
      }
    }
    for (const it of field.iterations) {
      columns.push({
        key: it.id,
        label: it.title,
        color: '',
        rows: bucket.get(it.id) ?? []
      })
    }
    if (emptyRows.length > 0) {
      columns.push({
        key: '__empty__',
        label: translate(
          'auto.components.github.project.ProjectViewKanban.56d805c8f8',
          'No {{value0}}',
          {
            value0: field.name
          }
        ),
        color: '',
        rows: emptyRows
      })
    }
    return columns
  }

  return []
}

// ─── Board Card ─────────────────────────────────────────────────────────

function BoardCard({
  row,
  groupField,
  isDragging,
  onDragStart,
  onDragEnd,
  onOpenDialog
}: {
  row: GitHubProjectRow
  groupField: GitHubProjectField | null
  isDragging: boolean
  onDragStart: (e: React.DragEvent, rowId: string, groupKey: string) => void
  onDragEnd: () => void
  onOpenDialog?: (row: GitHubProjectRow) => void
}): React.JSX.Element {
  const isRedacted = row.itemType === 'REDACTED'
  const isPR = row.itemType === 'PULL_REQUEST'

  return (
    <div
      draggable={!isRedacted}
      onDragStart={(e) => {
        if (isRedacted) {
          return
        }
        e.dataTransfer.setData('text/plain', '')
        e.dataTransfer.effectAllowed = 'move'
        const fieldValue = groupField ? row.fieldValuesByFieldId[groupField.id] : null
        const groupKey =
          fieldValue?.kind === 'single-select'
            ? fieldValue.optionId
            : fieldValue?.kind === 'iteration'
              ? fieldValue.iterationId
              : '__empty__'
        onDragStart(e, row.id, groupKey)
      }}
      onDragEnd={onDragEnd}
      role="button"
      tabIndex={isRedacted ? -1 : 0}
      className={cn(
        // Card container: clean, elevated feel with smooth transitions
        'group/card cursor-pointer select-none rounded-lg border border-white/10 bg-[#16161a]',
        'transition-all duration-150 ease-out',
        'hover:border-white/20 hover:bg-[#1c1c20]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]',
        isDragging && 'opacity-40 scale-[0.98]',
        isRedacted && 'pointer-events-none opacity-50'
      )}
      onClick={() => {
        if (!isRedacted) {
          onOpenDialog?.(row)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (!isRedacted) {
            onOpenDialog?.(row)
          }
        }
      }}
    >
      {/* Card body */}
      <div className="px-3 py-2.5">
        {/* Title row */}
        <div className="flex items-start gap-2">
          <span className="mt-[3px] shrink-0 text-white/15 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-visible/card:opacity-100">
            <GripVertical className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            {isRedacted ? (
              <span className="inline-flex items-center gap-1.5 text-white/40 italic">
                <Lock className="size-3 shrink-0" />
                {translate(
                  'auto.components.github.project.ProjectViewKanban.be36abc351',
                  'Restricted'
                )}
              </span>
            ) : (
              <span className="block text-[13px] font-medium leading-snug text-white/90">
                {row.content.title}
              </span>
            )}
          </div>
        </div>

        {/* Issue number + metadata row */}
        <div className="mt-2 flex items-center gap-2">
          {row.content.number != null && (
            <span className="shrink-0 text-[11px] tabular-nums text-white/30">
              #{row.content.number}
            </span>
          )}
          {isPR && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400">
              <GitPullRequest className="size-3" />
              {translate('auto.components.github.project.ProjectViewKanban.e34607e0cd', 'PR')}
            </span>
          )}
          {row.content.assignees.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-white/30">
              <User className="size-3" />
              {row.content.assignees.length}
            </span>
          )}
        </div>

        {/* Labels */}
        {row.content.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {row.content.labels.slice(0, 3).map((l) => (
              <span
                key={l.name}
                className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium leading-none"
                style={{ borderColor: `${l.color}44`, color: `#${l.color}` }}
              >
                {l.name}
              </span>
            ))}
            {row.content.labels.length > 3 && (
              <span className="text-[10px] text-white/30">+{row.content.labels.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Column Header ──────────────────────────────────────────────────────

function BoardColumnHeader({
  label,
  count,
  color
}: {
  label: string
  count: number
  color: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-white/5 px-3 py-3">
      {color !== '' && (
        <span
          className="inline-block size-2 shrink-0 rounded-sm"
          style={{ background: `#${color}` }}
        />
      )}
      <span className="text-[12px] font-semibold tracking-wide text-white/70 truncate">
        {label}
      </span>
      <span className="ml-auto shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums leading-none text-white/60">
        {count}
      </span>
    </div>
  )
}

// ─── Kanban Board ───────────────────────────────────────────────────────

export default function ProjectViewKanban({
  table,
  onOpenDialog,
  onEditField
}: Props): React.JSX.Element {
  const groupField = getGroupField(table)
  const sortedRows = useMemo(() => {
    if (!table.selectedView.groupByFields[0]) {
      return table.rows
    }
    return sortRows(table, table.rows)
  }, [table])
  const columns = useMemo(() => {
    if (!groupField) {
      return []
    }
    return buildColumns(groupField, sortedRows)
  }, [groupField, sortedRows])

  const dragStateRef = useRef<DragState>(null)
  const dragOverTargetRef = useRef<string | null>(null)
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null)
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null)

  const doMoveCard = useCallback(
    (rowId: string, sourceKey: string, targetKey: string) => {
      if (sourceKey === targetKey || !groupField) {
        return
      }
      const row = table.rows.find((r) => r.id === rowId)
      if (!row) {
        return
      }
      if (targetKey === '__empty__') {
        onEditField?.(row, groupField.id, null)
      } else if (groupField.kind === 'iteration') {
        onEditField?.(row, groupField.id, { kind: 'iteration', iterationId: targetKey })
      } else {
        onEditField?.(row, groupField.id, { kind: 'single-select', optionId: targetKey })
      }
    },
    [groupField, onEditField, table.rows]
  )

  const handleDragStart = useCallback((_e: React.DragEvent, rowId: string, groupKey: string) => {
    dragStateRef.current = { rowId, sourceGroupKey: groupKey }
    dragOverTargetRef.current = null
    setDraggingRowId(rowId)
  }, [])

  const handleDragEnd = useCallback(() => {
    const state = dragStateRef.current
    const targetKey = dragOverTargetRef.current
    if (state && targetKey !== null && targetKey !== state.sourceGroupKey) {
      doMoveCard(state.rowId, state.sourceGroupKey, targetKey)
    }
    dragStateRef.current = null
    dragOverTargetRef.current = null
    setDraggingRowId(null)
    setDragOverGroupKey(null)
  }, [doMoveCard])

  const handleColumnDragOver = useCallback((e: React.DragEvent, groupKey: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    dragOverTargetRef.current = groupKey
    setDragOverGroupKey(groupKey)
  }, [])

  const handleColumnDragLeave = useCallback((groupKey: string) => {
    setDragOverGroupKey((prev) => (prev === groupKey ? null : prev))
  }, [])

  if (columns.length === 0) {
    return (
      <div className="flex min-h-[120px] items-center justify-center p-6 text-sm text-muted-foreground">
        {translate(
          'auto.components.github.project.ProjectViewKanban.2d0beb1b12',
          "No items match this view's filter."
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden bg-[#0d0d10] p-4 scrollbar-sleek">
      {columns.map((col) => {
        const isDropTarget = dragOverGroupKey === col.key
        return (
          <div
            key={col.key}
            className={cn(
              'flex w-[272px] shrink-0 flex-col rounded-xl border border-white/[0.06] bg-white/[0.02]',
              'transition-colors duration-150',
              isDropTarget && 'border-primary/30 bg-primary/[0.04] ring-1 ring-primary/20'
            )}
            onDragOver={(e) => handleColumnDragOver(e, col.key)}
            onDragLeave={() => handleColumnDragLeave(col.key)}
          >
            <BoardColumnHeader label={col.label} count={col.rows.length} color={col.color} />
            <div className="flex-1 space-y-2 overflow-y-auto p-2 scrollbar-sleek">
              {col.rows.map((row) => (
                <BoardCard
                  key={row.id}
                  row={row}
                  groupField={groupField}
                  isDragging={draggingRowId === row.id}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onOpenDialog={onOpenDialog}
                />
              ))}
              {col.rows.length === 0 && (
                <div className="flex min-h-[80px] items-center justify-center rounded-lg border border-dashed border-white/[0.06] text-[12px] text-white/20">
                  {translate(
                    'auto.components.github.project.ProjectViewKanban.cf7f3699e4',
                    'Drop items here'
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

type DragState = {
  rowId: string
  sourceGroupKey: string
} | null
