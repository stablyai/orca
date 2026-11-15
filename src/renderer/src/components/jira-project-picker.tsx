import type React from 'react'
import type { JiraProject } from '../../../shared/jira/jira-types'
import {
  normalizeJiraProjectReference,
  type JiraProjectReference
} from '../../../shared/jira/jira-project-reference'
import { getJiraProjectSelectionKey } from './task-page/jira/task-page-jira-project-selection'
import { useTranslate } from '@/i18n/use-translate'
import { WorkItemScopePicker, type WorkItemScopeOption } from './work-item-scope-picker'

export function JiraProjectPicker({
  projects,
  value,
  onChange,
  label,
  emptyLabel,
  disabled,
  size,
  returnFocusRef
}: {
  projects: readonly JiraProject[]
  value: JiraProjectReference | null
  onChange: (project: JiraProjectReference | null) => void
  label: string
  emptyLabel: string
  disabled?: boolean
  size?: 'default' | 'xs'
  returnFocusRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  const options: WorkItemScopeOption<JiraProjectReference>[] = projects.flatMap((project) => {
    const reference = normalizeJiraProjectReference(project)
    return reference
      ? [
          {
            key: getJiraProjectSelectionKey(project),
            value: reference,
            label: `${project.key} · ${project.name}`,
            searchText: `${project.key} ${project.name} ${project.siteName ?? ''} ${project.siteId}`,
            description: project.siteName
          }
        ]
      : []
  })
  return (
    <WorkItemScopePicker
      options={options}
      selectedKey={value ? getJiraProjectSelectionKey(value) : null}
      selectedLabel={value ? `${value.key} · ${value.name}` : undefined}
      onChange={onChange}
      label={label}
      allLabel={emptyLabel}
      searchPlaceholder={t('components.jiraProjectPicker.search', 'Search Jira projects')}
      emptyLabel={t('components.jiraProjectPicker.empty', 'No projects found.')}
      disabled={disabled}
      size={size}
      returnFocusRef={returnFocusRef}
    />
  )
}
