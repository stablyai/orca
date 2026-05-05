import React, { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import ProjectGroupHeader from './ProjectGroupHeader'
import ProjectRow, { buildGridTemplate } from './ProjectRow'
import { groupRows, sortRows } from './group-sort'
import { getAvailableColumns, loadHiddenColumns, saveHiddenColumns } from './columns'
import type {
  GitHubIssueType,
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectSortDirection,
  GitHubProjectTable
} from '../../../../shared/github-project-types'

type SortOverride = { fieldId: string; direction: GitHubProjectSortDirection }

type Props = {
  table: GitHubProjectTable
  onOpenDialog?: (row: GitHubProjectRow) => void
  onEditField?: (
    row: GitHubProjectRow,
    fieldId: string,
    value: GitHubProjectFieldMutationValue | null
  ) => void
  onEditAssignees?: (row: GitHubProjectRow, add: string[], remove: string[]) => void
  onEditLabels?: (row: GitHubProjectRow, add: string[], remove: string[]) => void
  onEditIssueType?: (row: GitHubProjectRow, issueType: GitHubIssueType | null) => void
  onStartWork?: (row: GitHubProjectRow) => void
  onOpenInBrowser?: (row: GitHubProjectRow) => void
}

export default function ProjectViewList({
  table,
  onOpenDialog,
  onEditField,
  onEditAssignees,
  onEditLabels,
  onEditIssueType,
  onStartWork,
  onOpenInBrowser
}: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  // Why: column-header clicks override the view's saved sortByFields locally
  // without persisting to GitHub — matches GitHub Projects' transient
  // header-sort behavior. `null` means "use the view's sort as authored".
  const [sortOverride, setSortOverride] = useState<SortOverride | null>(null)

  // Why: include project id so the same view id colliding across projects
  // doesn't cross-pollute hidden-column preferences.
  const scopeKey = `${table.project.id}:${table.selectedView.id}`
  const availableFields = useMemo(
    () => getAvailableColumns(table.selectedView),
    [table.selectedView]
  )
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => loadHiddenColumns(scopeKey))
  useEffect(() => {
    setHidden(loadHiddenColumns(scopeKey))
  }, [scopeKey])
  const fields = useMemo(
    () => availableFields.filter((f) => !hidden.has(f.id)),
    [availableFields, hidden]
  )

  const toggleColumn = (fieldId: string): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(fieldId)) {
        next.delete(fieldId)
      } else {
        next.add(fieldId)
      }
      saveHiddenColumns(scopeKey, next)
      return next
    })
  }

  const effectiveTable = useMemo<GitHubProjectTable>(() => {
    if (!sortOverride) {
      return table
    }
    const field = fields.find((f) => f.id === sortOverride.fieldId)
    if (!field) {
      return table
    }
    return {
      ...table,
      selectedView: {
        ...table.selectedView,
        sortByFields: [{ field, direction: sortOverride.direction }]
      }
    }
  }, [table, fields, sortOverride])

  const groups = useMemo(() => {
    // Why: sort first, then group. Sorting the flat stream ensures rows within
    // each group honor the view's sortByFields too — groupRows preserves input
    // order within each bucket.
    const sorted = sortRows(effectiveTable, effectiveTable.rows)
    return groupRows(effectiveTable, sorted)
  }, [effectiveTable])

  const handleSortClick = (fieldId: string): void => {
    setSortOverride((prev) => {
      if (!prev || prev.fieldId !== fieldId) {
        return { fieldId, direction: 'ASC' }
      }
      if (prev.direction === 'ASC') {
        return { fieldId, direction: 'DESC' }
      }
      return null
    })
  }

  if (table.rows.length === 0) {
    return (
      <div className="flex min-h-[120px] items-center justify-center p-6 text-sm text-muted-foreground">
        No items match this view&apos;s filter.
      </div>
    )
  }

  // Why: the visible sort indicator reflects either the local override or the
  // first persisted sort from the view, so users see what's actually driving
  // row order.
  const activeSort: SortOverride | null = sortOverride
    ? sortOverride
    : effectiveTable.selectedView.sortByFields[0]
      ? {
          fieldId: effectiveTable.selectedView.sortByFields[0].field.id,
          direction: effectiveTable.selectedView.sortByFields[0].direction
        }
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ProjectHeaderRow
        fields={fields}
        availableFields={availableFields}
        hidden={hidden}
        onToggleColumn={toggleColumn}
        activeSort={activeSort}
        onSortClick={handleSortClick}
      />
      {groups.map((g) => {
        const expanded = !collapsed.has(g.key)
        return (
          <div key={g.key}>
            {table.selectedView.groupByFields[0] ? (
              <ProjectGroupHeader
                group={g}
                expanded={expanded}
                onToggle={() => {
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(g.key)) {
                      next.delete(g.key)
                    } else {
                      next.add(g.key)
                    }
                    return next
                  })
                }}
              />
            ) : null}
            {expanded
              ? g.rows.map((row) => (
                  <ProjectRow
                    key={row.id}
                    row={row}
                    fields={fields}
                    editable
                    onOpenDialog={() => onOpenDialog?.(row)}
                    onEditField={(fieldId, value) => onEditField?.(row, fieldId, value)}
                    onEditAssignees={(add, remove) => onEditAssignees?.(row, add, remove)}
                    onEditLabels={(add, remove) => onEditLabels?.(row, add, remove)}
                    onEditIssueType={(issueType) => onEditIssueType?.(row, issueType)}
                    onStartWork={() => onStartWork?.(row)}
                    onOpenInBrowser={() => onOpenInBrowser?.(row)}
                  />
                ))
              : null}
          </div>
        )
      })}
    </div>
  )
}

function ProjectHeaderRow({
  fields,
  availableFields,
  hidden,
  onToggleColumn,
  activeSort,
  onSortClick
}: {
  fields: GitHubProjectField[]
  availableFields: GitHubProjectField[]
  hidden: ReadonlySet<string>
  onToggleColumn: (fieldId: string) => void
  activeSort: SortOverride | null
  onSortClick: (fieldId: string) => void
}): React.JSX.Element {
  // Why: matches GitHub Projects' fixed column header — sticky so it stays
  // pinned while scrolling the rows beneath it. The trailing slot mirrors the
  // hover-action column in ProjectRow so columns line up exactly.
  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-3 border-b border-border/60 bg-background/95 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur"
      style={{ gridTemplateColumns: buildGridTemplate(fields) }}
    >
      {fields.map((f) => {
        const isActive = activeSort?.fieldId === f.id
        const Icon = isActive ? (activeSort.direction === 'ASC' ? ArrowUp : ArrowDown) : ArrowUpDown
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onSortClick(f.id)}
            className={cn(
              'group flex min-w-0 items-center gap-1 truncate text-left uppercase tracking-wide hover:text-foreground',
              isActive && 'text-foreground'
            )}
            aria-label={`Sort by ${f.name}`}
          >
            <span className="truncate">{f.name}</span>
            <Icon
              className={cn(
                'size-3 shrink-0 transition-opacity',
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
              )}
            />
          </button>
        )
      })}
      <div className="flex items-center justify-end">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Configure columns"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Columns3 className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Columns
            </div>
            {availableFields.map((f) => {
              // Why: TITLE is the only column that anchors the row's identity
              // and click target — disallow hiding it so users can't end up
              // with a row of metadata they can't open.
              const locked = f.dataType === 'TITLE'
              const visible = !hidden.has(f.id)
              return (
                <label
                  key={f.id}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50',
                    locked && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={locked}
                    onChange={() => onToggleColumn(f.id)}
                    className="size-3.5"
                  />
                  <span className="truncate">{f.name}</span>
                </label>
              )
            })}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
