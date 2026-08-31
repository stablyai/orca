import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import type { JiraCreateField, JiraIssueType } from '../../../../../shared/jira-types'
import type { LinearProjectSummary } from '../../../../../shared/linear/project-types'

export function useTaskPageCreateDialogResets({
  providerRuntimeContextKey,
  setNewLinearIssueOpen,
  setNewLinearIssueTitle,
  setNewLinearIssueBody,
  setNewLinearIssueTeamId,
  setNewLinearIssueStateId,
  setNewLinearIssueAssigneeId,
  setNewLinearIssuePriority,
  setNewLinearIssueProjectId,
  setNewLinearIssueLabelIds,
  setNewLinearIssueProjects,
  setNewLinearIssueProjectsLoading,
  setNewLinearIssueSubmitting,
  setNewJiraIssueOpen,
  setNewJiraIssueTitle,
  setNewJiraIssueBody,
  setNewJiraIssueProjectId,
  setNewJiraIssueProjectComboboxOpen,
  setNewJiraIssueProjectQuery,
  setNewJiraIssueProjectCommandValue,
  setNewJiraIssueTypeId,
  setAvailableJiraIssueTypes,
  setJiraIssueTypesLoading,
  setJiraCreateFields,
  setJiraCreateFieldsLoading,
  setJiraCreateFieldsError,
  setNewJiraIssueCustomFieldValues,
  setNewJiraIssueSubmitting
}: {
  providerRuntimeContextKey: string
  setNewLinearIssueOpen: Dispatch<SetStateAction<boolean>>
  setNewLinearIssueTitle: Dispatch<SetStateAction<string>>
  setNewLinearIssueBody: Dispatch<SetStateAction<string>>
  setNewLinearIssueTeamId: Dispatch<SetStateAction<string | null>>
  setNewLinearIssueStateId: Dispatch<SetStateAction<string | null>>
  setNewLinearIssueAssigneeId: Dispatch<SetStateAction<string | null>>
  setNewLinearIssuePriority: Dispatch<SetStateAction<number>>
  setNewLinearIssueProjectId: Dispatch<SetStateAction<string | null>>
  setNewLinearIssueLabelIds: Dispatch<SetStateAction<string[]>>
  setNewLinearIssueProjects: Dispatch<SetStateAction<LinearProjectSummary[]>>
  setNewLinearIssueProjectsLoading: Dispatch<SetStateAction<boolean>>
  setNewLinearIssueSubmitting: Dispatch<SetStateAction<boolean>>
  setNewJiraIssueOpen: Dispatch<SetStateAction<boolean>>
  setNewJiraIssueTitle: Dispatch<SetStateAction<string>>
  setNewJiraIssueBody: Dispatch<SetStateAction<string>>
  setNewJiraIssueProjectId: Dispatch<SetStateAction<string | null>>
  setNewJiraIssueProjectComboboxOpen: Dispatch<SetStateAction<boolean>>
  setNewJiraIssueProjectQuery: Dispatch<SetStateAction<string>>
  setNewJiraIssueProjectCommandValue: Dispatch<SetStateAction<string>>
  setNewJiraIssueTypeId: Dispatch<SetStateAction<string | null>>
  setAvailableJiraIssueTypes: Dispatch<SetStateAction<JiraIssueType[]>>
  setJiraIssueTypesLoading: Dispatch<SetStateAction<boolean>>
  setJiraCreateFields: Dispatch<SetStateAction<JiraCreateField[]>>
  setJiraCreateFieldsLoading: Dispatch<SetStateAction<boolean>>
  setJiraCreateFieldsError: Dispatch<SetStateAction<string | null>>
  setNewJiraIssueCustomFieldValues: Dispatch<SetStateAction<Record<string, string>>>
  setNewJiraIssueSubmitting: Dispatch<SetStateAction<boolean>>
}): void {
  const previousProviderRuntimeContextKeyRef = useRef(providerRuntimeContextKey)

  useEffect(() => {
    if (previousProviderRuntimeContextKeyRef.current === providerRuntimeContextKey) {
      return
    }
    previousProviderRuntimeContextKeyRef.current = providerRuntimeContextKey
    // Why: reset regardless of open state — a closed dialog would otherwise reopen with the previous provider's draft.
    setNewLinearIssueOpen(false)
    setNewLinearIssueTitle('')
    setNewLinearIssueBody('')
    setNewLinearIssueTeamId(null)
    setNewLinearIssueStateId(null)
    setNewLinearIssueAssigneeId(null)
    setNewLinearIssuePriority(0)
    setNewLinearIssueProjectId(null)
    setNewLinearIssueLabelIds([])
    setNewLinearIssueProjects([])
    setNewLinearIssueProjectsLoading(false)
    setNewLinearIssueSubmitting(false)
    setNewJiraIssueOpen(false)
    setNewJiraIssueTitle('')
    setNewJiraIssueBody('')
    setNewJiraIssueProjectId(null)
    setNewJiraIssueProjectComboboxOpen(false)
    setNewJiraIssueProjectQuery('')
    setNewJiraIssueProjectCommandValue('')
    setNewJiraIssueTypeId(null)
    setAvailableJiraIssueTypes([])
    setJiraIssueTypesLoading(false)
    setJiraCreateFields([])
    setJiraCreateFieldsLoading(false)
    setJiraCreateFieldsError(null)
    setNewJiraIssueCustomFieldValues({})
    setNewJiraIssueSubmitting(false)
  }, [
    providerRuntimeContextKey,
    setNewLinearIssueTitle,
    setNewLinearIssuePriority,
    setNewJiraIssueProjectQuery,
    setNewLinearIssueProjectsLoading,
    setJiraIssueTypesLoading,
    setJiraCreateFieldsLoading,
    setJiraCreateFieldsError,
    setJiraCreateFields,
    setNewLinearIssueSubmitting,
    setNewLinearIssueOpen,
    setNewJiraIssueProjectComboboxOpen,
    setNewLinearIssueStateId,
    setNewLinearIssueBody,
    setNewJiraIssueCustomFieldValues,
    setNewJiraIssueProjectCommandValue,
    setNewLinearIssueTeamId,
    setNewJiraIssueBody,
    setNewLinearIssueAssigneeId,
    setNewJiraIssueOpen,
    setNewJiraIssueTitle,
    setNewJiraIssueTypeId,
    setNewJiraIssueSubmitting,
    setNewLinearIssueProjects,
    setAvailableJiraIssueTypes,
    setNewLinearIssueLabelIds,
    setNewJiraIssueProjectId,
    setNewLinearIssueProjectId
  ])
}
