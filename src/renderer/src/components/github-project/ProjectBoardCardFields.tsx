import React from 'react'
import ProjectCell from './ProjectCell'
import { hasNonEmptyFieldValue } from '../../../../shared/github/project-group-sort'
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectView
} from '../../../../shared/github/project-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

// The card's own header and avatar stack already render these.
const CARD_HEADER_DATA_TYPES = new Set(['TITLE', 'ASSIGNEES', 'REPOSITORY'])
const NAMED_VALUE_DATA_TYPES = new Set(['TEXT', 'NUMBER', 'DATE'])

/** Visible fields a card renders as chips — the column and swimlane fields are already implied by placement. */
export function boardCardFields(
  view: GitHubProjectView,
  impliedFieldIds: ReadonlySet<string>
): GitHubProjectField[] {
  return view.fields.filter(
    (field) => !CARD_HEADER_DATA_TYPES.has(field.dataType) && !impliedFieldIds.has(field.id)
  )
}

export function boardCardShowsAssignees(view: GitHubProjectView): boolean {
  return view.fields.some((field) => field.dataType === 'ASSIGNEES')
}

function cardFieldHasValue(row: GitHubProjectRow, field: GitHubProjectField): boolean {
  if (field.dataType === 'LABELS') {
    return row.content.labels.length > 0
  }
  if (field.dataType === 'PARENT_ISSUE') {
    return row.content.parentIssue !== null
  }
  return hasNonEmptyFieldValue(row.fieldValuesByFieldId[field.id])
}

export function ProjectBoardCardFields({
  row,
  fields,
  sourceHost,
  sourceTarget
}: {
  row: GitHubProjectRow
  fields: GitHubProjectField[]
  sourceHost?: string
  sourceTarget: RuntimeClientTarget
}): React.JSX.Element | null {
  const present = fields.filter((field) => cardFieldHasValue(row, field))
  if (present.length === 0) {
    return null
  }
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
      {present.map((field) => (
        <span
          key={field.id}
          className="inline-flex min-w-0 max-w-full items-center gap-1 text-2xs text-muted-foreground"
        >
          {NAMED_VALUE_DATA_TYPES.has(field.dataType) ? (
            <span className="shrink-0">{field.name}:</span>
          ) : null}
          <ProjectCell
            row={row}
            field={field}
            editable={false}
            sourceHost={sourceHost}
            sourceTarget={sourceTarget}
          />
        </span>
      ))}
    </div>
  )
}
