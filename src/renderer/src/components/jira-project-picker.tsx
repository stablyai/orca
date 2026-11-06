import type { JiraProject } from '../../../shared/jira/jira-types'
import {
  normalizeJiraProjectReference,
  type JiraProjectReference
} from '../../../shared/jira/jira-project-reference'
import { getJiraProjectSelectionKey } from './task-page/jira/task-page-jira-project-selection'
import { translate } from '@/i18n/i18n'
import { WorkItemScopePicker, type WorkItemScopeOption } from './work-item-scope-picker'

export function JiraProjectPicker({
  projects,
  value,
  onChange,
  label,
  emptyLabel,
  disabled
}: {
  projects: readonly JiraProject[]
  value: JiraProjectReference | null
  onChange: (project: JiraProjectReference | null) => void
  label: string
  emptyLabel: string
  disabled?: boolean
}): React.JSX.Element {
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
      searchPlaceholder={translate('components.jiraProjectPicker.search', 'Search Jira projects')}
      emptyLabel={translate('components.jiraProjectPicker.empty', 'No projects found.')}
      disabled={disabled}
    />
  )
}
