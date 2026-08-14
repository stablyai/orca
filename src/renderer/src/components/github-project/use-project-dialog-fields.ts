// Why: shared field-aggregation for the item dialog's project-fields renderers
// (ProjectFieldsGrid + ProjectFieldsSection) so filtering stays in sync.
import { useCallback, useMemo } from 'react'
import { getAvailableColumns } from './columns'
import { useAppStore } from '@/store'
import type { GitHubItemDialogProjectOrigin } from '../GitHubItemDialog'
import type {
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github/project-types'
import type { GlobalSettings } from '../../../../shared/types'

/** Fields managed by the dialog itself — not re-rendered as project fields. */
const DIALOG_OWNED_DATA_TYPES = new Set([
  'TITLE',
  'ASSIGNEES',
  'LABELS',
  'REPOSITORY',
  'MILESTONE',
  'LINKED_PULL_REQUESTS',
  'REVIEWERS',
  'PARENT_ISSUE',
  'SUB_ISSUES_PROGRESS',
  'TRACKS',
  'TRACKED_BY'
])

/** GitHub auto-generated timestamp fields — not user-editable project fields. */
const BUILTIN_TIMESTAMP_NAMES = new Set(['created', 'updated', 'closed'])

function isProjectField(f: GitHubProjectField): boolean {
  if (DIALOG_OWNED_DATA_TYPES.has(f.dataType)) {
    return false
  }
  if (f.id === '__type__') {
    return false
  }
  if (BUILTIN_TIMESTAMP_NAMES.has(f.name.toLowerCase())) {
    return false
  }
  return true
}

export function useProjectDialogFields(projectOrigin: GitHubItemDialogProjectOrigin): {
  table: GitHubProjectTable | null
  row: GitHubProjectRow | null
  fields: GitHubProjectField[]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  handleEditField: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
  sourceHost?: string
} {
  const entry = useAppStore((s) => s.projectViewCache[projectOrigin.cacheKey] ?? null)
  const table = entry?.data ?? null
  const row = useMemo(
    () => table?.rows.find((r) => r.id === projectOrigin.projectItemId) ?? null,
    [table, projectOrigin.projectItemId]
  )
  const fields = useMemo(() => {
    if (!table) {
      return []
    }
    const seen = new Set<string>()
    const all: GitHubProjectField[] = []
    const add = (f: GitHubProjectField) => {
      if (!seen.has(f.id)) {
        seen.add(f.id)
        all.push(f)
      }
    }
    for (const f of getAvailableColumns(table.selectedView)) {
      add(f)
    }
    for (const f of table.selectedView.groupByFields) {
      add(f)
    }
    for (const s of table.selectedView.sortByFields) {
      add(s.field)
    }
    // Why: project-level fields not in the view (fetched by main process)
    for (const f of table.projectFields) {
      add(f)
    }
    return all.filter(isProjectField)
  }, [table])
  const settings = useAppStore((s) => s.settings)
  const updateProjectFieldValue = useAppStore((s) => s.updateProjectFieldValue)
  const clearProjectFieldValue = useAppStore((s) => s.clearProjectFieldValue)

  const handleEditField = useCallback(
    (fieldId: string, value: GitHubProjectFieldMutationValue | null) => {
      if (value === null) {
        void clearProjectFieldValue(projectOrigin.cacheKey, projectOrigin.projectItemId, fieldId)
      } else {
        void updateProjectFieldValue(
          projectOrigin.cacheKey,
          projectOrigin.projectItemId,
          fieldId,
          value
        )
      }
    },
    [
      clearProjectFieldValue,
      projectOrigin.cacheKey,
      projectOrigin.projectItemId,
      updateProjectFieldValue
    ]
  )

  return {
    table,
    row,
    fields,
    settings,
    handleEditField,
    sourceHost: table?.project.host
  }
}
