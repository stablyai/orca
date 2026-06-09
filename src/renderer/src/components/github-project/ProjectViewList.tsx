import React, { useCallback, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import ColumnResizeHandle from './ColumnResizeHandle'
import ProjectGroupHeader from './ProjectGroupHeader'
import ProjectRow from './ProjectRow'
import { groupRows, sortRows } from '../../../../shared/github-project-group-sort'
import { getAvailableColumns, loadHiddenColumns, saveHiddenColumns } from './columns'
import {
  ACTION_COLUMN_WIDTH,
  loadColumnWidths,
  MIN_COLUMN_WIDTH,
  resolveWidth,
  saveColumnWidths
} from './column-widths'
import type {
  GitHubIssueType,
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectSortDirection,
  GitHubProjectTable
} from '../../../../shared/github-project-types'
import { translate } from '@/i18n/i18n'

type SortOverride = { fieldId: string; direction: GitHubProjectSortDirection }

const PROJECT_FROZEN_COLUMN_HEADER_SURFACE_CLASS =
  '[background:color-mix(in_srgb,var(--background)_95%,var(--muted))]'

function buildProjectGridTemplate(
  fields: GitHubProjectField[],
  widths: Readonly<Record<string, number>>
): string {
  // Why: the first two columns are frozen during horizontal scroll, so their
  // actual widths must be deterministic for the second sticky offset.
  const cols = fields.map((field, index) =>
    index < 2
      ? `${resolveWidth(field, widths)}px`
      : `minmax(${MIN_COLUMN_WIDTH}px, ${resolveWidth(field, widths)}fr)`
  )
  cols.push(`${ACTION_COLUMN_WIDTH}px`)
  return cols.join(' ')
}

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
  // Why: switching project views should not paint one commit with the
  // previous view's local column preferences before an Effect catches up.
  const persistedHidden = useMemo(() => loadHiddenColumns(scopeKey), [scopeKey])
  const [hiddenByScope, setHiddenByScope] = useState<
    Readonly<Record<string, ReadonlySet<string> | undefined>>
  >({})
  const hidden = hiddenByScope[scopeKey] ?? persistedHidden
  const fields = useMemo(
    () => availableFields.filter((f) => !hidden.has(f.id)),
    [availableFields, hidden]
  )

  const persistedWidths = useMemo(() => loadColumnWidths(scopeKey), [scopeKey])
  const [widthsByScope, setWidthsByScope] = useState<
    Readonly<Record<string, Readonly<Record<string, number>> | undefined>>
  >({})
  const widths = widthsByScope[scopeKey] ?? persistedWidths

  const setColumnPair = useCallback(
    (fieldId: string, width: number, nextFieldId: string, nextWidth: number): void => {
      setWidthsByScope((prev) => {
        const currentWidths = prev[scopeKey] ?? persistedWidths
        const updated = {
          ...currentWidths,
          [fieldId]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)),
          [nextFieldId]: Math.max(MIN_COLUMN_WIDTH, Math.round(nextWidth))
        }
        saveColumnWidths(scopeKey, updated)
        return { ...prev, [scopeKey]: updated }
      })
    },
    [persistedWidths, scopeKey]
  )

  const gridTemplate = useMemo(() => buildProjectGridTemplate(fields, widths), [fields, widths])

  const handleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    // Why: frozen columns need the horizontal offset, but piping every scroll
    // tick through React state rerenders the entire project row set.
    event.currentTarget.style.setProperty(
      '--project-scroll-left',
      `${event.currentTarget.scrollLeft}px`
    )
  }, [])

  const toggleColumn = (fieldId: string): void => {
    setHiddenByScope((prev) => {
      const next = new Set(prev[scopeKey] ?? persistedHidden)
      if (next.has(fieldId)) {
        next.delete(fieldId)
      } else {
        next.add(fieldId)
      }
      saveHiddenColumns(scopeKey, next)
      return { ...prev, [scopeKey]: next }
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
        {translate("auto.components.github.project.ProjectViewList.4f57d2e0b1", "No items match this view's filter.")}</div>
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
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto scrollbar-sleek"
      style={{ '--project-scroll-left': '0px' } as React.CSSProperties}
      onScroll={handleListScroll}
    >
      <ProjectHeaderRow
        fields={fields}
        availableFields={availableFields}
        hidden={hidden}
        onToggleColumn={toggleColumn}
        activeSort={activeSort}
        onSortClick={handleSortClick}
        widths={widths}
        gridTemplate={gridTemplate}
        onResizeColumn={setColumnPair}
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
                    gridTemplate={gridTemplate}
                    widths={widths}
                    onResizeColumn={setColumnPair}
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
  onSortClick,
  widths,
  gridTemplate,
  onResizeColumn
}: {
  fields: GitHubProjectField[]
  availableFields: GitHubProjectField[]
  hidden: ReadonlySet<string>
  onToggleColumn: (fieldId: string) => void
  activeSort: SortOverride | null
  onSortClick: (fieldId: string) => void
  widths: Readonly<Record<string, number>>
  gridTemplate: string
  onResizeColumn: (fieldId: string, width: number, nextFieldId: string, nextWidth: number) => void
}): React.JSX.Element {
  // Why: matches GitHub Projects' fixed column header — sticky so it stays
  // pinned while scrolling the rows beneath it. The trailing slot mirrors the
  // hover-action column in ProjectRow so columns line up exactly.
  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-3 border-b border-border/60 bg-background/95 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {fields.map((f, idx) => {
        const isActive = activeSort?.fieldId === f.id
        const Icon = isActive ? (activeSort.direction === 'ASC' ? ArrowUp : ArrowDown) : ArrowUpDown
        // Why: only render a resize handle when there is a neighbor to
        // borrow width from. The trailing field has no field neighbor on
        // its right (the action column is fixed and not part of the
        // user-resizable pair set), so omit its handle to keep the total
        // table width invariant.
        const next = fields[idx + 1]
        const frozen = idx < 2
        return (
          <div
            key={f.id}
            className={cn(
              'flex min-w-0 items-center',
              !frozen && 'relative',
              frozen &&
                cn(
                  'relative z-20 backdrop-blur before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
                  PROJECT_FROZEN_COLUMN_HEADER_SURFACE_CLASS
                ),
              idx === 1 && 'border-r border-border/50'
            )}
            style={
              frozen ? { transform: 'translateX(var(--project-scroll-left, 0px))' } : undefined
            }
          >
            <button
              type="button"
              onClick={() => onSortClick(f.id)}
              className={cn(
                'group flex min-w-0 flex-1 items-center gap-1 truncate text-left uppercase tracking-wide hover:text-foreground',
                isActive && 'text-foreground'
              )}
              aria-label={translate("auto.components.github.project.ProjectViewList.eddfc7a794", "Sort by {{value0}}", { value0: f.name })}
            >
              <span className="truncate">{f.name}</span>
              <Icon
                className={cn(
                  'size-3 shrink-0 transition-opacity',
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
                )}
              />
            </button>
            {next ? (
              <ColumnResizeHandle
                fieldId={f.id}
                nextFieldId={next.id}
                currentWidth={resolveWidth(f, widths)}
                nextWidth={resolveWidth(next, widths)}
                onResize={onResizeColumn}
              />
            ) : null}
          </div>
        )
      })}
      <div className="flex items-center justify-end">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={translate("auto.components.github.project.ProjectViewList.f949f5b2b7", "Configure columns")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Columns3 className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {translate("auto.components.github.project.ProjectViewList.989f81dc2a", "Columns")}</div>
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
