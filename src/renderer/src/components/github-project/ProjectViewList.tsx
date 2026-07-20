import React, { useCallback, useEffect, useMemo, useState } from 'react'
import ProjectGroupHeader from './ProjectGroupHeader'
import ProjectHeaderRow, { type SortOverride } from './ProjectHeaderRow'
import ProjectRow from './ProjectRow'
import { groupRows, sortRows } from '../../../../shared/github-project-group-sort'
import {
  buildProjectRowTree,
  flattenProjectRowTree,
  type ProjectRowTreeNode
} from '../../../../shared/github-project-hierarchy-tree'
import {
  getAvailableColumns,
  loadHiddenColumns,
  loadHierarchyModePreference,
  saveHiddenColumns,
  saveHierarchyModePreference
} from './columns'
import {
  buildProjectGridTemplate,
  loadColumnWidths,
  MIN_COLUMN_WIDTH,
  minColumnWidthFor,
  saveColumnWidths
} from './column-widths'
import type {
  GitHubIssueType,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github-project-types'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

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
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

export default function ProjectViewList({
  table,
  onOpenDialog,
  onEditField,
  onEditAssignees,
  onEditLabels,
  onEditIssueType,
  onStartWork,
  onOpenInBrowser,
  sourceSettings
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

  const persistedHierarchyMode = useMemo(() => loadHierarchyModePreference(scopeKey), [scopeKey])
  const [hierarchyModeByScope, setHierarchyModeByScope] = useState<
    Readonly<Record<string, boolean | undefined>>
  >({})
  const hierarchyMode = hierarchyModeByScope[scopeKey] ?? persistedHierarchyMode
  // Why: row collapse state is transient — switching project/view starts
  // fully expanded instead of carrying stale row ids from another table.
  const [collapsedRows, setCollapsedRows] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    setCollapsedRows(new Set())
  }, [scopeKey])

  const setColumnPair = useCallback(
    (fieldId: string, width: number, nextFieldId: string, nextWidth: number): void => {
      setWidthsByScope((prev) => {
        const currentWidths = prev[scopeKey] ?? persistedWidths
        const field = fields.find((f) => f.id === fieldId)
        const nextField = fields.find((f) => f.id === nextFieldId)
        const floor = field ? minColumnWidthFor(field) : MIN_COLUMN_WIDTH
        const nextFloor = nextField ? minColumnWidthFor(nextField) : MIN_COLUMN_WIDTH
        const updated = {
          ...currentWidths,
          [fieldId]: Math.max(floor, Math.round(width)),
          [nextFieldId]: Math.max(nextFloor, Math.round(nextWidth))
        }
        saveColumnWidths(scopeKey, updated)
        return { ...prev, [scopeKey]: updated }
      })
    },
    [fields, persistedWidths, scopeKey]
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

  const treeNodesByGroupKey = useMemo(() => {
    if (!hierarchyMode) {
      return null
    }
    const map = new Map<string, ProjectRowTreeNode[]>()
    for (const g of groups) {
      // Why: trees build per group bucket — a child grouped apart from its
      // parent renders as an unindented root in its own group by design.
      map.set(g.key, flattenProjectRowTree(buildProjectRowTree(g.rows), collapsedRows))
    }
    return map
  }, [groups, hierarchyMode, collapsedRows])

  const toggleRowCollapse = useCallback((rowId: string): void => {
    setCollapsedRows((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) {
        next.delete(rowId)
      } else {
        next.add(rowId)
      }
      return next
    })
  }, [])

  const toggleHierarchyMode = useCallback((): void => {
    setHierarchyModeByScope((prev) => {
      const next = !(prev[scopeKey] ?? persistedHierarchyMode)
      saveHierarchyModePreference(scopeKey, next)
      return { ...prev, [scopeKey]: next }
    })
  }, [scopeKey, persistedHierarchyMode])

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
        {translate(
          'auto.components.github.project.ProjectViewList.4f57d2e0b1',
          "No items match this view's filter."
        )}
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
        hierarchyMode={hierarchyMode}
        onToggleHierarchyMode={toggleHierarchyMode}
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
              ? hierarchyMode && treeNodesByGroupKey
                ? (treeNodesByGroupKey.get(g.key) ?? []).map((node) => (
                    <ProjectRow
                      key={node.row.id}
                      row={node.row}
                      tree={{
                        depth: node.depth,
                        hasChildren: node.children.length > 0,
                        expanded: !collapsedRows.has(node.row.id),
                        onToggleExpand: () => toggleRowCollapse(node.row.id)
                      }}
                      fields={fields}
                      gridTemplate={gridTemplate}
                      widths={widths}
                      onResizeColumn={setColumnPair}
                      editable
                      onOpenDialog={() => onOpenDialog?.(node.row)}
                      onEditField={(fieldId, value) => onEditField?.(node.row, fieldId, value)}
                      onEditAssignees={(add, remove) => onEditAssignees?.(node.row, add, remove)}
                      onEditLabels={(add, remove) => onEditLabels?.(node.row, add, remove)}
                      onEditIssueType={(issueType) => onEditIssueType?.(node.row, issueType)}
                      onStartWork={() => onStartWork?.(node.row)}
                      onOpenInBrowser={() => onOpenInBrowser?.(node.row)}
                      sourceSettings={sourceSettings}
                    />
                  ))
                : g.rows.map((row) => (
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
                      sourceSettings={sourceSettings}
                    />
                  ))
              : null}
          </div>
        )
      })}
    </div>
  )
}
