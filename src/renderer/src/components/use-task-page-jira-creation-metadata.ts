import type { TaskPageJiraCreationStateModel } from './use-task-page-jira-creation-state'
import { useEffect } from 'react'
import { jiraListIssueTypes, jiraListCreateFields } from '@/runtime/runtime-jira-client'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
export function useTaskPageJiraCreationMetadata(model: TaskPageJiraCreationStateModel) {
  const {
    settings,
    jiraConnected,
    jiraTaskSourceContext,
    newJiraIssueOpen,
    setNewJiraIssueTypeId,
    setAvailableJiraIssueTypes,
    setJiraIssueTypesLoading,
    setJiraCreateFields,
    setJiraCreateFieldsLoading,
    setJiraCreateFieldsError,
    setNewJiraIssueCustomFieldValues,
    newJiraIssueTargetProject,
    newJiraIssueTargetType
  } = model
  useEffect(() => {
    if (!newJiraIssueOpen || !jiraConnected || !newJiraIssueTargetProject) {
      setAvailableJiraIssueTypes([])
      setJiraIssueTypesLoading(false)
      return
    }
    let cancelled = false
    setAvailableJiraIssueTypes([])
    setJiraIssueTypesLoading(true)
    void jiraListIssueTypes(
      jiraTaskSourceContext ?? settings,
      newJiraIssueTargetProject.id,
      newJiraIssueTargetProject.siteId
    )
      .then((issueTypes) => {
        if (cancelled) {
          return
        }
        setAvailableJiraIssueTypes(issueTypes)
        setNewJiraIssueTypeId(issueTypes[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(
            translate('auto.components.TaskPage.af2a8371de', 'Failed to load Jira issue types.')
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setJiraIssueTypesLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    settings,
    jiraConnected,
    newJiraIssueOpen,
    newJiraIssueTargetProject,
    jiraTaskSourceContext,
    setAvailableJiraIssueTypes,
    setJiraIssueTypesLoading,
    setNewJiraIssueTypeId
  ])
  useEffect(() => {
    if (
      !newJiraIssueOpen ||
      !jiraConnected ||
      !newJiraIssueTargetProject ||
      !newJiraIssueTargetType
    ) {
      setJiraCreateFields([])
      setJiraCreateFieldsLoading(false)
      setJiraCreateFieldsError(null)
      setNewJiraIssueCustomFieldValues({})
      return
    }
    let cancelled = false
    setJiraCreateFields([])
    setJiraCreateFieldsLoading(true)
    setJiraCreateFieldsError(null)
    setNewJiraIssueCustomFieldValues({})
    void jiraListCreateFields(
      jiraTaskSourceContext ?? settings,
      newJiraIssueTargetProject.id,
      newJiraIssueTargetType.id,
      newJiraIssueTargetProject.siteId
    )
      .then((fields) => {
        if (!cancelled) {
          setJiraCreateFields(fields)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setJiraCreateFieldsError(
            translate(
              'auto.components.task.page.hooks.use.task.page.jira.create.dialog.jiraRequiredFieldsLoadFailed',
              'Failed to load required Jira fields.'
            )
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setJiraCreateFieldsLoading(false)
        }
      })
    return () => {
      // Why: create fields are scoped to project + issue type; ignore late responses after switching either selector.
      cancelled = true
    }
  }, [
    settings,
    jiraConnected,
    newJiraIssueOpen,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    jiraTaskSourceContext,
    setNewJiraIssueCustomFieldValues,
    setJiraCreateFieldsLoading,
    setJiraCreateFields,
    setJiraCreateFieldsError
  ])

  // Why: defense-in-depth — keep stale cache rows from leaking across the issue/PR split tabs.
  return model
}
export type TaskPageJiraCreationMetadataModel = ReturnType<typeof useTaskPageJiraCreationMetadata>
