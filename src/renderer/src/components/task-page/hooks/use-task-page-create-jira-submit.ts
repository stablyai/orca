import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import { jiraCreateIssue, jiraGetIssue } from '@/runtime/runtime-jira-client'
import { buildJiraCreateCustomFields } from '@/components/task-page-jira-create-fields'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type {
  JiraCreateField,
  JiraIssue,
  JiraIssueType,
  JiraProject
} from '../../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function useTaskPageCreateJiraSubmit({
  newJiraIssueTargetProject,
  newJiraIssueTargetType,
  newJiraIssueTitle,
  newJiraIssueSubmitting,
  hasMissingJiraCreateField,
  jiraCreateFieldsLoading,
  visibleJiraCreateFields,
  newJiraIssueCustomFieldValues,
  providerRuntimeContextKey,
  providerRuntimeContextKeyRef,
  jiraTaskSourceContext,
  settings,
  newJiraIssueBody,
  discardNewJiraIssueDraft,
  setNewJiraIssueSubmitting,
  setNewJiraIssueOpen,
  setNewJiraIssueTitle,
  setNewJiraIssueBody,
  setNewJiraIssueCustomFieldValues,
  setJiraRefreshNonce,
  setJiraIssues,
  setSelectedJiraIssue
}: {
  newJiraIssueTargetProject: JiraProject | null
  newJiraIssueTargetType: JiraIssueType | null
  newJiraIssueTitle: string
  newJiraIssueSubmitting: boolean
  hasMissingJiraCreateField: boolean
  jiraCreateFieldsLoading: boolean
  visibleJiraCreateFields: JiraCreateField[]
  newJiraIssueCustomFieldValues: Record<string, string>
  providerRuntimeContextKey: string
  providerRuntimeContextKeyRef: { current: string }
  jiraTaskSourceContext: TaskSourceContext | null
  settings: GlobalSettings | null
  newJiraIssueBody: string
  discardNewJiraIssueDraft: () => void
  setNewJiraIssueSubmitting: Dispatch<SetStateAction<boolean>>
  setNewJiraIssueOpen: Dispatch<SetStateAction<boolean>>
  setNewJiraIssueTitle: Dispatch<SetStateAction<string>>
  setNewJiraIssueBody: Dispatch<SetStateAction<string>>
  setNewJiraIssueCustomFieldValues: Dispatch<SetStateAction<Record<string, string>>>
  setJiraRefreshNonce: Dispatch<SetStateAction<number>>
  setJiraIssues: Dispatch<SetStateAction<JiraIssue[]>>
  setSelectedJiraIssue: (issue: JiraIssue | null) => void
}) {
  const handleCreateNewJiraIssue = useCallback(async (): Promise<void> => {
    if (!newJiraIssueTargetProject || !newJiraIssueTargetType) {
      return
    }
    const title = newJiraIssueTitle.trim()
    if (!title || newJiraIssueSubmitting || hasMissingJiraCreateField || jiraCreateFieldsLoading) {
      return
    }
    const customFields = buildJiraCreateCustomFields(
      visibleJiraCreateFields,
      newJiraIssueCustomFieldValues
    )
    setNewJiraIssueSubmitting(true)
    const submitProviderRuntimeContextKey = providerRuntimeContextKey
    try {
      const result = await jiraCreateIssue(jiraTaskSourceContext ?? settings, {
        siteId: newJiraIssueTargetProject.siteId,
        projectId: newJiraIssueTargetProject.id,
        issueTypeId: newJiraIssueTargetType.id,
        title,
        description: newJiraIssueBody || undefined,
        customFields
      })
      if (submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current) {
        return
      }
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.TaskPage.aec5feeb69', 'Failed to create Jira issue.')
        )
        return
      }
      toast.success(
        translate('auto.components.TaskPage.cb98f0350c', 'Created {{value0}}', {
          value0: result.key
        }),
        {
          action: result.url
            ? {
                label: translate('auto.components.TaskPage.9c57663908', 'View'),
                onClick: () => window.open(result.url, '_blank', 'noopener,noreferrer')
              }
            : undefined
        }
      )
      discardNewJiraIssueDraft()
      setNewJiraIssueOpen(false)
      setNewJiraIssueTitle('')
      setNewJiraIssueBody('')
      setNewJiraIssueCustomFieldValues({})
      setJiraRefreshNonce((n) => n + 1)

      void jiraGetIssue(
        jiraTaskSourceContext ?? settings,
        result.key,
        newJiraIssueTargetProject.siteId
      )
        .then((full) => {
          if (submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current) {
            return
          }
          if (full) {
            // Why: list cache may still be fresh after create; insert the new row locally before selecting so the inspector stays open.
            setJiraIssues((prev) => [full, ...prev.filter((issue) => issue.key !== full.key)])
            setSelectedJiraIssue(full)
          }
        })
        .catch(() => {})
    } catch (error) {
      if (submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate('auto.components.TaskPage.aec5feeb69', 'Failed to create Jira issue.')
        )
      }
    } finally {
      if (submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current) {
        setNewJiraIssueSubmitting(false)
      }
    }
  }, [
    hasMissingJiraCreateField,
    jiraCreateFieldsLoading,
    newJiraIssueBody,
    newJiraIssueCustomFieldValues,
    newJiraIssueSubmitting,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    newJiraIssueTitle,
    providerRuntimeContextKey,
    jiraTaskSourceContext,
    settings,
    setSelectedJiraIssue,
    visibleJiraCreateFields,
    discardNewJiraIssueDraft,

    providerRuntimeContextKeyRef,
    setNewJiraIssueCustomFieldValues,
    setNewJiraIssueBody,
    setJiraIssues,
    setNewJiraIssueOpen,
    setNewJiraIssueTitle,
    setJiraRefreshNonce,
    setNewJiraIssueSubmitting
  ])

  return { handleCreateNewJiraIssue }
}
