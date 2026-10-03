import { useCallback } from 'react'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { getJiraSelfUser } from '@/components/jira-self-user'
import { JiraUserPicker, type JiraUserPickerFixedOption } from '@/components/jira-user-picker'
import { hasJiraAssigneeCreateField } from '@/components/task-page-jira-create-fields'
import { getJiraProjectSelectionKey } from '@/components/task-page-jira-project-selection'
import { jiraListAssignableUsersForProject } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'

/**
 * Assignee picker of the new-issue dialog: Automatic (Jira's project default),
 * one-click "Assign to me", or any project-assignable user. Hidden when the
 * target create screen does not accept an assignee, since Jira rejects creates
 * that set a field absent from the screen.
 */
export function TaskPageJiraIssueAssigneeField({
  model
}: {
  model: TaskPageComposerActionsModel
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
  const projectId = newJiraIssueTargetProject?.id
  const projectSiteId = newJiraIssueTargetProject?.siteId
  const searchAssignableUsers = useCallback(
    (query: string) =>
      projectId
        ? jiraListAssignableUsersForProject(providerSettings, projectId, query, projectSiteId)
        : Promise.resolve([]),
    [projectId, projectSiteId, providerSettings]
  )
  if (!hasJiraAssigneeCreateField(jiraCreateFields)) {
    return null
  }
  const selfUser = getJiraSelfUser(jiraStatus, projectSiteId ?? null)
  const assigneeLabel = translate(
    'auto.components.task.page.jira.IssueAssigneeField.9f36a855a2',
    'Assignee'
  )
  const automaticLabel = translate(
    'auto.components.task.page.jira.IssueAssigneeField.3a45582d68',
    'Automatic'
  )
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
              'auto.components.task.page.jira.IssueAssigneeField.b2693ea957',
              'Assign to me ({{value0}})',
              { value0: selfUser.displayName }
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
          // Why: remounting per project drops search results cached from the
          // previous project or site, which are not assignable here.
          key={
            newJiraIssueTargetProject
              ? getJiraProjectSelectionKey(newJiraIssueTargetProject)
              : 'no-project'
          }
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
