import type { TaskPageLinearIssueCreationModel } from './use-task-page-linear-issue-creation'
import { useCallback } from 'react'
import { buildJiraCreateCustomFields } from '@/components/task-page-jira-create-fields'
import { jiraCreateIssue, jiraGetIssue } from '@/runtime/runtime-jira-client'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
export function useTaskPageJiraIssueCreation(model: TaskPageLinearIssueCreationModel) {
  const {
    settings,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    jiraTaskSourceContext,
    setSelectedJiraIssue,
    setJiraIssues,
    setJiraRefreshNonce,
    setNewJiraIssueOpen,
    newJiraIssueTitle,
    setNewJiraIssueTitle,
    newJiraIssueBody,
    setNewJiraIssueBody,
    newJiraIssueSubmitting,
    setNewJiraIssueSubmitting,
    jiraCreateFieldsLoading,
    newJiraIssueCustomFieldValues,
    setNewJiraIssueCustomFieldValues,
    discardNewJiraIssueDraft,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    visibleJiraCreateFields,
    hasMissingJiraCreateField
  } = model
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
                onClick: () => window.open(result.url, '_blank')
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
    setJiraIssues,
    setJiraRefreshNonce,
    providerRuntimeContextKeyRef,
    setNewJiraIssueOpen,
    setNewJiraIssueTitle,
    setNewJiraIssueBody,
    setNewJiraIssueCustomFieldValues,
    setNewJiraIssueSubmitting
  ])
  const nextModel = model as typeof model & {
    handleCreateNewJiraIssue: typeof handleCreateNewJiraIssue
  }
  nextModel.handleCreateNewJiraIssue = handleCreateNewJiraIssue
  return nextModel
}
export type TaskPageJiraIssueCreationModel = ReturnType<typeof useTaskPageJiraIssueCreation>
