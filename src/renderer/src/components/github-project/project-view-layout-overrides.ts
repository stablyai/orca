// Why: GitHub's API cannot edit a view's layout config, so the View menu
// layers a per-device override on top of the fetched view and never writes it
// back. Persisted in localStorage for the same reason as hidden columns.
import { useCallback, useMemo, useState } from 'react'
import {
  isRenderableProjectViewLayout,
  type GitHubProjectField,
  type GitHubProjectTable,
  type GitHubProjectView,
  type GitHubProjectViewLayout
} from '../../../../shared/github/project-types'

export type ProjectViewLayoutOverrides = {
  layout?: GitHubProjectViewLayout
  /** Visible fields; absent keeps the view's own. */
  fieldIds?: string[]
  /** Board column field. */
  columnFieldId?: string
  /** Board swimlanes / table and roadmap grouping; null turns grouping off. */
  groupFieldId?: string | null
}

const STORAGE_KEY = 'orca.githubProject.viewLayoutOverrides'

export function projectViewLayoutScopeKey(table: GitHubProjectTable): string {
  return `${table.project.id}:${table.selectedView.id}`
}

/** The view's fields first (GitHub's order), then fields the view hides. */
export function projectFieldPool(table: GitHubProjectTable): GitHubProjectField[] {
  const view = table.selectedView
  const seen = new Set<string>()
  const pool: GitHubProjectField[] = []
  for (const field of [
    ...view.fields,
    ...(table.projectFields ?? []),
    ...(view.verticalGroupByFields ?? []),
    ...view.groupByFields
  ]) {
    if (!seen.has(field.id)) {
      seen.add(field.id)
      pool.push(field)
    }
  }
  return pool
}

export function isBoardColumnField(field: GitHubProjectField): boolean {
  return field.kind === 'single-select' || field.kind === 'iteration'
}

/** Fields whose item values arrive in `fieldValuesByFieldId`, so rows can bucket by them. */
export function isGroupableField(field: GitHubProjectField): boolean {
  return (
    isBoardColumnField(field) ||
    field.dataType === 'ASSIGNEES' ||
    field.dataType === 'TEXT' ||
    field.dataType === 'NUMBER' ||
    field.dataType === 'DATE'
  )
}

export function hasProjectViewLayoutOverrides(
  overrides: ProjectViewLayoutOverrides | undefined
): boolean {
  return Boolean(
    overrides &&
    (overrides.layout !== undefined ||
      overrides.fieldIds !== undefined ||
      overrides.columnFieldId !== undefined ||
      overrides.groupFieldId !== undefined)
  )
}

export function applyProjectViewLayoutOverrides(
  table: GitHubProjectTable,
  overrides: ProjectViewLayoutOverrides | undefined
): GitHubProjectTable {
  if (!overrides || !hasProjectViewLayoutOverrides(overrides)) {
    return table
  }
  const pool = projectFieldPool(table)
  const byId = new Map(pool.map((field) => [field.id, field]))
  const view: GitHubProjectView = { ...table.selectedView }
  if (overrides.layout && isRenderableProjectViewLayout(overrides.layout)) {
    view.layout = overrides.layout
  }
  if (overrides.fieldIds) {
    const wanted = new Set(overrides.fieldIds)
    // Title anchors every row and card, so it can't be hidden.
    const fields = pool.filter((field) => field.dataType === 'TITLE' || wanted.has(field.id))
    if (fields.length > 0) {
      view.fields = fields
    }
  }
  const column = overrides.columnFieldId ? byId.get(overrides.columnFieldId) : undefined
  if (column && isBoardColumnField(column)) {
    view.verticalGroupByFields = [column]
  }
  if (overrides.groupFieldId === null) {
    view.groupByFields = []
  } else if (overrides.groupFieldId) {
    const group = byId.get(overrides.groupFieldId)
    if (group && isGroupableField(group)) {
      view.groupByFields = [group]
    }
  }
  return { ...table, selectedView: view }
}

type OverridesMap = Record<string, ProjectViewLayoutOverrides>

function readMap(): OverridesMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written only by saveProjectViewLayoutOverrides; apply re-validates every id and layout.
        (parsed as OverridesMap)
      : {}
  } catch {
    return {}
  }
}

export function loadProjectViewLayoutOverrides(
  scopeKey: string
): ProjectViewLayoutOverrides | undefined {
  return readMap()[scopeKey]
}

export function saveProjectViewLayoutOverrides(
  scopeKey: string,
  overrides: ProjectViewLayoutOverrides | undefined
): void {
  const map = readMap()
  if (hasProjectViewLayoutOverrides(overrides) && overrides) {
    map[scopeKey] = overrides
  } else {
    delete map[scopeKey]
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage may be disabled — overrides just won't persist this session.
  }
}

export function useProjectViewLayoutOverrides(scopeKey: string | null): {
  overrides: ProjectViewLayoutOverrides | undefined
  update: (patch: ProjectViewLayoutOverrides) => void
  reset: () => void
} {
  const persisted = useMemo(
    () => (scopeKey ? loadProjectViewLayoutOverrides(scopeKey) : undefined),
    [scopeKey]
  )
  const [byScope, setByScope] = useState<
    Readonly<Record<string, ProjectViewLayoutOverrides | undefined>>
  >({})
  const overrides = scopeKey && scopeKey in byScope ? byScope[scopeKey] : persisted
  const commit = useCallback(
    (next: ProjectViewLayoutOverrides | undefined) => {
      if (!scopeKey) {
        return
      }
      saveProjectViewLayoutOverrides(scopeKey, next)
      setByScope((previous) => ({ ...previous, [scopeKey]: next }))
    },
    [scopeKey]
  )
  const update = useCallback(
    (patch: ProjectViewLayoutOverrides) => commit({ ...overrides, ...patch }),
    [commit, overrides]
  )
  const reset = useCallback(() => commit(undefined), [commit])
  return { overrides, update, reset }
}
