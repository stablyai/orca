import React from 'react'
import { TYPE_FIELD_DATA_TYPE } from './columns'
import type {
  GitHubIssueType,
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow
} from '../../../../shared/github/project-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { ProjectTitleCell, ProjectTypeCell } from './ProjectCellIdentity'
import { ProjectAssigneesCell, ProjectLabelsCell } from './ProjectCellRepositoryEditors'
import { ProjectIterationCell, ProjectSingleSelectCell } from './ProjectCellSelectionEditors'
import {
  ProjectDateCell,
  ProjectLabelChip,
  ProjectTextCell,
  ProjectUserChip
} from './ProjectCellValueEditors'

type Props = {
  row: GitHubProjectRow
  field: GitHubProjectField
  editable: boolean
  onEditField?: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
  onEditAssignees?: (add: string[], remove: string[]) => void
  onEditLabels?: (add: string[], remove: string[]) => void
  onEditIssueType?: (issueType: GitHubIssueType | null) => void
  onOpenDialog?: () => void
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

export default function ProjectCell({
  row,
  field,
  editable,
  onEditField,
  onEditAssignees,
  onEditLabels,
  onEditIssueType,
  onOpenDialog,
  sourceHost,
  sourceSettings
}: Props): React.JSX.Element {
  const value = row.fieldValuesByFieldId[field.id]
  const editableValue = editable && row.itemType !== 'REDACTED'
  if (field.dataType === 'TITLE') {
    return <ProjectTitleCell row={row} onOpenDialog={onOpenDialog} />
  }
  if (field.dataType === TYPE_FIELD_DATA_TYPE) {
    return (
      <ProjectTypeCell
        row={row}
        editable={editableValue && row.itemType === 'ISSUE'}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditIssueType={onEditIssueType}
      />
    )
  }
  if (field.dataType === 'ASSIGNEES') {
    return (
      <ProjectAssigneesCell
        row={row}
        editable={editableValue && row.itemType !== 'DRAFT_ISSUE'}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditAssignees={onEditAssignees}
      />
    )
  }
  if (field.dataType === 'LABELS') {
    return (
      <ProjectLabelsCell
        row={row}
        editable={editableValue && row.itemType !== 'DRAFT_ISSUE'}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditLabels={onEditLabels}
      />
    )
  }
  if (field.dataType === 'REPOSITORY') {
    return (
      <span className="truncate text-xs text-muted-foreground">{row.content.repository ?? ''}</span>
    )
  }
  if (field.dataType === 'PARENT_ISSUE') {
    return (
      <span className="truncate text-xs text-muted-foreground">
        {row.content.parentIssue ? `#${row.content.parentIssue.number}` : ''}
      </span>
    )
  }
  if (field.kind === 'single-select') {
    return (
      <ProjectSingleSelectCell
        row={row}
        field={field}
        editable={editableValue}
        onEditField={onEditField}
      />
    )
  }
  if (field.kind === 'iteration') {
    return (
      <ProjectIterationCell
        row={row}
        field={field}
        editable={editableValue}
        onEditField={onEditField}
      />
    )
  }
  if (field.dataType === 'TEXT') {
    const text = value?.kind === 'text' ? value.text : ''
    return (
      <ProjectTextCell
        value={text}
        editable={editableValue}
        placeholder={translate('auto.components.github.project.ProjectCell.9cb1a0c984', 'Add text')}
        onCommit={(next) =>
          onEditField?.(field.id, next === '' ? null : { kind: 'text', text: next })
        }
      />
    )
  }
  if (field.dataType === 'NUMBER') {
    const number = value?.kind === 'number' ? String(value.number) : ''
    return (
      <ProjectTextCell
        value={number}
        editable={editableValue}
        numeric
        placeholder={translate(
          'auto.components.github.project.ProjectCell.bb7ebc11e3',
          'Add number'
        )}
        onCommit={(next) => commitNumber(field.id, next, onEditField)}
      />
    )
  }
  if (field.dataType === 'DATE') {
    const date = value?.kind === 'date' ? value.date : ''
    return (
      <ProjectDateCell
        key={date}
        value={date}
        editable={editableValue}
        label={field.name}
        onCommit={(next) => onEditField?.(field.id, next ? { kind: 'date', date: next } : null)}
      />
    )
  }
  if (value?.kind === 'labels') {
    return (
      <div className="flex flex-wrap gap-1">
        {value.labels.map((label) => (
          <ProjectLabelChip key={label.name} label={label} />
        ))}
      </div>
    )
  }
  if (value?.kind === 'users') {
    return (
      <div className="flex flex-wrap gap-1">
        {value.users.map((user) => (
          <ProjectUserChip key={user.login} user={user} />
        ))}
      </div>
    )
  }
  return <span />
}

function commitNumber(fieldId: string, value: string, onEditField: Props['onEditField']): void {
  if (value === '') {
    onEditField?.(fieldId, null)
    return
  }
  const number = Number(value)
  if (Number.isFinite(number)) {
    onEditField?.(fieldId, { kind: 'number', number })
  }
}
