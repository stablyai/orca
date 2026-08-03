// Why: renders editable project-specific fields (Status, Priority, Iteration,
// custom text/number/date) inline in the item dialog. Filters out issue-level
// fields (Title, Labels, Assignees, Repository, Milestone) which the dialog
// handles separately.
import React, { useCallback, useMemo } from 'react'
import ProjectCell from './ProjectCell'
import { getAvailableColumns } from './columns'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { GitHubItemDialogProjectOrigin } from '../GitHubItemDialog'
import type {
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow
} from '../../../../shared/github-project-types'
import type { GlobalSettings } from '../../../../shared/types'

type Props = {
  projectOrigin: GitHubItemDialogProjectOrigin
  className?: string
}

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

function isProjectField(f: GitHubProjectField): boolean {
  if (DIALOG_OWNED_DATA_TYPES.has(f.dataType)) {
    return false
  }
  if (f.id === '__type__') {
    return false
  }
  return true
}

export default function ProjectFieldsSection({
  projectOrigin,
  className
}: Props): React.JSX.Element | null {
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

  if (!row || fields.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-border/50 bg-card/50 p-3',
        className
      )}
    >
      {fields.map((field) => (
        <ProjectFieldRow
          key={field.id}
          row={row}
          field={field}
          onEditField={handleEditField}
          sourceSettings={settings}
          sourceHost={table?.project.host}
        />
      ))}
    </div>
  )
}

function ProjectFieldRow({
  row,
  field,
  onEditField,
  sourceSettings,
  sourceHost
}: {
  row: GitHubProjectRow
  field: GitHubProjectField
  onEditField: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  sourceHost?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-24 shrink-0 text-[11px] text-muted-foreground truncate">{field.name}</span>
      <div className="min-w-0 flex-1">
        <ProjectCell
          row={row}
          field={field}
          editable={row.itemType !== 'REDACTED'}
          onEditField={onEditField}
          sourceHost={sourceHost}
          sourceSettings={sourceSettings}
        />
      </div>
    </div>
  )
}
