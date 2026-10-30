import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { JiraUserPicker } from '@/components/jira-user-picker'
import { getJiraSelfUser } from '@/components/jira-self-user'
import { useJiraSourceConnection } from '@/components/new-workspace/use-jira-source-connection'
import { useAppStore } from '@/store'
import { compareBaseSensitivityLocaleText } from '../../../shared/locale-text-collators'
import { jiraListAssignableUsersForTarget } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { JiraIssue, JiraIssueUpdate, JiraUser } from '../../../shared/jira/jira-types'

export function JiraIssueAssigneeControl({
  issue,
  disabled,
  sourceContext,
  owner,
  runtimeContextKey,
  mutateIssue
}: {
  issue: JiraIssue
  disabled: boolean
  sourceContext?: TaskSourceContext | null
  owner: RuntimeClientTarget
  runtimeContextKey: string
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>
  ) => Promise<unknown>
}): React.JSX.Element {
  const defaultStatus = useAppStore((state) => state.jiraStatus)
  const defaultStatusKey = useAppStore((state) => state.jiraStatusContextKey)
  const connection = useJiraSourceConnection({
    enabled: true,
    sourceContext: sourceContext ?? null
  })
  const status = sourceContext
    ? connection.status
    : defaultStatusKey === runtimeContextKey
      ? defaultStatus
      : null
  const self = getJiraSelfUser(status, issue.siteId)
  const selfAccountId = self?.accountId
  const searchUsers = useCallback(
    async (query: string) => {
      const found = await jiraListAssignableUsersForTarget(owner, issue.key, query, issue.siteId)
      return [...found].sort((a, b) => {
        if ((a.accountId === selfAccountId) !== (b.accountId === selfAccountId)) {
          return a.accountId === selfAccountId ? -1 : 1
        }
        return (
          compareBaseSensitivityLocaleText(a.displayName, b.displayName) ||
          a.accountId.localeCompare(b.accountId)
        )
      })
    },
    [issue.key, issue.siteId, owner, selfAccountId]
  )
  const assign = (user: JiraUser | null): void => {
    if (disabled) {
      return
    }
    void mutateIssue(
      'assignee',
      { assigneeAccountId: user?.accountId ?? null },
      { assignee: user ?? undefined }
    )
  }
  const sourceKey = sourceContext ? getTaskSourceCacheScope(sourceContext) : runtimeContextKey
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="w-40">
        <JiraUserPicker
          key={JSON.stringify([sourceKey, issue.siteId, issue.key])}
          providerSettings={owner}
          siteId={issue.siteId}
          value={
            issue.assignee?.accountId ??
            translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')
          }
          selectedUser={issue.assignee ?? null}
          onSelect={assign}
          disabled={disabled}
          label={translate('components.jiraIssueAssigneeField.label', 'Assignee')}
          fixedOptions={[
            {
              key: 'unassigned',
              label: translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned'),
              onSelect: () => assign(null)
            }
          ]}
          searchUsers={searchUsers}
        />
      </div>
      {self && issue.assignee?.accountId !== self.accountId ? (
        <Button variant="ghost" size="xs" disabled={disabled} onClick={() => assign(self)}>
          {translate('components.jiraIssueAssigneeField.assignToMe', 'Assign to me ({{name}})', {
            name: self.displayName
          })}
        </Button>
      ) : null}
    </div>
  )
}
