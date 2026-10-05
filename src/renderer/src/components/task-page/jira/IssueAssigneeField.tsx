import { useCallback } from 'react'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { getJiraSelfUser } from '@/components/jira-self-user'
import { JiraUserPicker, type JiraUserPickerFixedOption } from '@/components/jira-user-picker'
import { hasJiraAssigneeCreateField } from '@/components/task-page-jira-create-fields'
import { getJiraProjectSelectionKey } from '@/components/task-page-jira-project-selection'
import { jiraListAssignableUsersForProject } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'

export function TaskPageJiraIssueAssigneeField({
  model
}: {
  model: Pick<
    TaskPageComposerActionsModel,
    | 'settings'
    | 'jiraTaskSourceContext'
    | 'jiraStatus'
    | 'jiraStatusCurrent'
    | 'jiraCreateFields'
    | 'newJiraIssueTargetProject'
    | 'newJiraIssueAssignee'
    | 'setNewJiraIssueAssignee'
    | 'newJiraIssueSubmitting'
    | 'providerRuntimeContextKey'
  >
}): React.JSX.Element | null {
  const {
    settings,
    jiraTaskSourceContext,
    jiraStatus,
    jiraCreateFields,
    newJiraIssueTargetProject,
    newJiraIssueAssignee,
    setNewJiraIssueAssignee,
    newJiraIssueSubmitting
  } = model
  const providerSettings = jiraTaskSourceContext ?? settings
  const projectKey = newJiraIssueTargetProject?.key
  const projectSiteId = newJiraIssueTargetProject?.siteId
  const searchAssignableUsers = useCallback(
    (query: string) =>
      projectKey
        ? jiraListAssignableUsersForProject(providerSettings, projectKey, query, projectSiteId)
        : Promise.resolve([]),
    [projectKey, projectSiteId, providerSettings]
  )
  if (!hasJiraAssigneeCreateField(jiraCreateFields)) {
    return null
  }
  const selfUser = model.jiraStatusCurrent
    ? getJiraSelfUser(jiraStatus, projectSiteId ?? null)
    : null
  const assigneeLabel = translate('components.jiraIssueAssigneeField.label', 'Assignee')
  const automaticLabel = translate('components.jiraIssueAssigneeField.automatic', 'Automatic')
  const fixedOptions: JiraUserPickerFixedOption[] = [
    {
      key: 'automatic',
      label: automaticLabel,
      onSelect: () => setNewJiraIssueAssignee(null)
    },
    ...(selfUser
      ? [
          {
            key: 'self',
            label: translate(
              'components.jiraIssueAssigneeField.assignToMe',
              'Assign to me ({{name}})',
              { name: selfUser.displayName }
            ),
            onSelect: () => setNewJiraIssueAssignee(selfUser)
          }
        ]
      : [])
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-[11px] font-medium text-muted-foreground">{assigneeLabel}</label>
        <JiraUserPicker
          // Cached candidates belong to one provider, project, and site.
          key={JSON.stringify([
            model.providerRuntimeContextKey,
            newJiraIssueTargetProject
              ? getJiraProjectSelectionKey(newJiraIssueTargetProject)
              : 'no-project'
          ])}
          providerSettings={providerSettings}
          siteId={projectSiteId ?? undefined}
          value={newJiraIssueAssignee ? newJiraIssueAssignee.accountId : automaticLabel}
          selectedUser={newJiraIssueAssignee}
          onSelect={(user) => setNewJiraIssueAssignee(user)}
          disabled={newJiraIssueSubmitting}
          label={assigneeLabel}
          fixedOptions={fixedOptions}
          searchUsers={searchAssignableUsers}
        />
      </div>
    </div>
  )
}
