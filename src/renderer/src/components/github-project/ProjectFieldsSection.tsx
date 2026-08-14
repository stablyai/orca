// Why: renders editable project-specific fields (Status, Priority, Iteration,
// custom text/number/date) inline in the item dialog. Filters out issue-level
// fields (Title, Labels, Assignees, Repository, Milestone) which the dialog
// handles separately.
import React from 'react'
import ProjectCell from './ProjectCell'
import { useProjectDialogFields } from './use-project-dialog-fields'
import { cn } from '@/lib/utils'
import type { GitHubItemDialogProjectOrigin } from '../GitHubItemDialog'
import type {
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow
} from '../../../../shared/github/project-types'
import type { GlobalSettings } from '../../../../shared/types'

type Props = {
  projectOrigin: GitHubItemDialogProjectOrigin
  className?: string
}

export default function ProjectFieldsSection({
  projectOrigin,
  className
}: Props): React.JSX.Element | null {
  const { row, fields, settings, handleEditField, sourceHost } =
    useProjectDialogFields(projectOrigin)

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
          sourceHost={sourceHost}
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
