import type { TaskPageGitHubMutationStateModel } from './use-task-page-github-mutation-state'
import { useState, useRef, useEffect } from 'react'
import type { JiraIssueType, JiraCreateField } from '../../../shared/jira-types'
import { useTaskCreationDraftRetention } from '@/components/use-task-creation-draft-retention'
import { writeNewJiraIssueDraft } from './task-page-draft-storage'
import { useTaskPageJiraCreationProjects } from './use-task-page-jira-creation-projects'
export function useTaskPageJiraCreationStatePrelude(model: TaskPageGitHubMutationStateModel) {
  const {
    providerRuntimeContextKey,
    newLinearIssueOpen,
    setNewLinearIssueOpen,
    setNewLinearIssueTitle,
    setNewLinearIssueBody,
    setNewLinearIssueTeamId,
    setNewLinearIssueSubmitting,
    setNewLinearIssueStateId,
    setNewLinearIssueAssigneeId,
    setNewLinearIssuePriority,
    setNewLinearIssueProjectId,
    setNewLinearIssueLabelIds,
    setNewLinearIssueProjects,
    setNewLinearIssueProjectsLoading
  } = model
  const [newJiraIssueOpen, setNewJiraIssueOpen] = useState(false)
  const [newJiraIssueTitle, setNewJiraIssueTitle] = useState('')
  const [newJiraIssueBody, setNewJiraIssueBody] = useState('')
  const [newJiraIssueProjectId, setNewJiraIssueProjectId] = useState<string | null>(null)
  const [newJiraIssueProjectComboboxOpen, setNewJiraIssueProjectComboboxOpen] = useState(false)
  const [newJiraIssueProjectQuery, setNewJiraIssueProjectQuery] = useState('')
  const [newJiraIssueProjectCommandValue, setNewJiraIssueProjectCommandValue] = useState('')
  const [newJiraIssueTypeId, setNewJiraIssueTypeId] = useState<string | null>(null)
  const [newJiraIssueSubmitting, setNewJiraIssueSubmitting] = useState(false)
  const newJiraIssueProjectSearchInputRef = useRef<HTMLInputElement | null>(null)
  const [availableJiraIssueTypes, setAvailableJiraIssueTypes] = useState<JiraIssueType[]>([])
  const [jiraIssueTypesLoading, setJiraIssueTypesLoading] = useState(false)
  const [jiraCreateFields, setJiraCreateFields] = useState<JiraCreateField[]>([])
  const [jiraCreateFieldsLoading, setJiraCreateFieldsLoading] = useState(false)
  const [jiraCreateFieldsError, setJiraCreateFieldsError] = useState<string | null>(null)
  const [newJiraIssueCustomFieldValues, setNewJiraIssueCustomFieldValues] = useState<
    Record<string, string>
  >({})
  const discardNewJiraIssueDraft = useTaskCreationDraftRetention({
    open: newJiraIssueOpen,
    draft: {
      title: newJiraIssueTitle,
      body: newJiraIssueBody
    },
    writeDraft: writeNewJiraIssueDraft
  })
  const previousProviderRuntimeContextKeyRef = useRef(providerRuntimeContextKey)
  // Why: provider changes must clear dependent composer state before stale values can be submitted.
  useEffect(() => {
    if (previousProviderRuntimeContextKeyRef.current === providerRuntimeContextKey) {
      return
    }
    previousProviderRuntimeContextKeyRef.current = providerRuntimeContextKey
    if (newLinearIssueOpen) {
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
    }
    if (newJiraIssueOpen) {
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
    }
  }, [
    newJiraIssueOpen,
    newLinearIssueOpen,
    providerRuntimeContextKey,
    setNewLinearIssuePriority,
    setNewLinearIssueBody,
    setNewLinearIssueProjectsLoading,
    setNewLinearIssueTeamId,
    setNewLinearIssueStateId,
    setNewLinearIssueAssigneeId,
    setNewLinearIssueTitle,
    setNewLinearIssueSubmitting,
    setNewLinearIssueProjects,
    setNewLinearIssueLabelIds,
    setNewLinearIssueOpen,
    setNewLinearIssueProjectId
  ])
  const nextModel = model as typeof model & {
    newJiraIssueOpen: typeof newJiraIssueOpen
    setNewJiraIssueOpen: typeof setNewJiraIssueOpen
    newJiraIssueTitle: typeof newJiraIssueTitle
    setNewJiraIssueTitle: typeof setNewJiraIssueTitle
    newJiraIssueBody: typeof newJiraIssueBody
    setNewJiraIssueBody: typeof setNewJiraIssueBody
    newJiraIssueProjectId: typeof newJiraIssueProjectId
    setNewJiraIssueProjectId: typeof setNewJiraIssueProjectId
    newJiraIssueProjectComboboxOpen: typeof newJiraIssueProjectComboboxOpen
    setNewJiraIssueProjectComboboxOpen: typeof setNewJiraIssueProjectComboboxOpen
    newJiraIssueProjectQuery: typeof newJiraIssueProjectQuery
    setNewJiraIssueProjectQuery: typeof setNewJiraIssueProjectQuery
    newJiraIssueProjectCommandValue: typeof newJiraIssueProjectCommandValue
    setNewJiraIssueProjectCommandValue: typeof setNewJiraIssueProjectCommandValue
    newJiraIssueTypeId: typeof newJiraIssueTypeId
    setNewJiraIssueTypeId: typeof setNewJiraIssueTypeId
    newJiraIssueSubmitting: typeof newJiraIssueSubmitting
    setNewJiraIssueSubmitting: typeof setNewJiraIssueSubmitting
    newJiraIssueProjectSearchInputRef: typeof newJiraIssueProjectSearchInputRef
    availableJiraIssueTypes: typeof availableJiraIssueTypes
    setAvailableJiraIssueTypes: typeof setAvailableJiraIssueTypes
    jiraIssueTypesLoading: typeof jiraIssueTypesLoading
    setJiraIssueTypesLoading: typeof setJiraIssueTypesLoading
    jiraCreateFields: typeof jiraCreateFields
    setJiraCreateFields: typeof setJiraCreateFields
    jiraCreateFieldsLoading: typeof jiraCreateFieldsLoading
    setJiraCreateFieldsLoading: typeof setJiraCreateFieldsLoading
    jiraCreateFieldsError: typeof jiraCreateFieldsError
    setJiraCreateFieldsError: typeof setJiraCreateFieldsError
    newJiraIssueCustomFieldValues: typeof newJiraIssueCustomFieldValues
    setNewJiraIssueCustomFieldValues: typeof setNewJiraIssueCustomFieldValues
    discardNewJiraIssueDraft: typeof discardNewJiraIssueDraft
    previousProviderRuntimeContextKeyRef: typeof previousProviderRuntimeContextKeyRef
  }
  nextModel.newJiraIssueOpen = newJiraIssueOpen
  nextModel.setNewJiraIssueOpen = setNewJiraIssueOpen
  nextModel.newJiraIssueTitle = newJiraIssueTitle
  nextModel.setNewJiraIssueTitle = setNewJiraIssueTitle
  nextModel.newJiraIssueBody = newJiraIssueBody
  nextModel.setNewJiraIssueBody = setNewJiraIssueBody
  nextModel.newJiraIssueProjectId = newJiraIssueProjectId
  nextModel.setNewJiraIssueProjectId = setNewJiraIssueProjectId
  nextModel.newJiraIssueProjectComboboxOpen = newJiraIssueProjectComboboxOpen
  nextModel.setNewJiraIssueProjectComboboxOpen = setNewJiraIssueProjectComboboxOpen
  nextModel.newJiraIssueProjectQuery = newJiraIssueProjectQuery
  nextModel.setNewJiraIssueProjectQuery = setNewJiraIssueProjectQuery
  nextModel.newJiraIssueProjectCommandValue = newJiraIssueProjectCommandValue
  nextModel.setNewJiraIssueProjectCommandValue = setNewJiraIssueProjectCommandValue
  nextModel.newJiraIssueTypeId = newJiraIssueTypeId
  nextModel.setNewJiraIssueTypeId = setNewJiraIssueTypeId
  nextModel.newJiraIssueSubmitting = newJiraIssueSubmitting
  nextModel.setNewJiraIssueSubmitting = setNewJiraIssueSubmitting
  nextModel.newJiraIssueProjectSearchInputRef = newJiraIssueProjectSearchInputRef
  nextModel.availableJiraIssueTypes = availableJiraIssueTypes
  nextModel.setAvailableJiraIssueTypes = setAvailableJiraIssueTypes
  nextModel.jiraIssueTypesLoading = jiraIssueTypesLoading
  nextModel.setJiraIssueTypesLoading = setJiraIssueTypesLoading
  nextModel.jiraCreateFields = jiraCreateFields
  nextModel.setJiraCreateFields = setJiraCreateFields
  nextModel.jiraCreateFieldsLoading = jiraCreateFieldsLoading
  nextModel.setJiraCreateFieldsLoading = setJiraCreateFieldsLoading
  nextModel.jiraCreateFieldsError = jiraCreateFieldsError
  nextModel.setJiraCreateFieldsError = setJiraCreateFieldsError
  nextModel.newJiraIssueCustomFieldValues = newJiraIssueCustomFieldValues
  nextModel.setNewJiraIssueCustomFieldValues = setNewJiraIssueCustomFieldValues
  nextModel.discardNewJiraIssueDraft = discardNewJiraIssueDraft
  nextModel.previousProviderRuntimeContextKeyRef = previousProviderRuntimeContextKeyRef
  return nextModel
}
export type TaskPageJiraCreationStatePreludeModel = ReturnType<
  typeof useTaskPageJiraCreationStatePrelude
>
export function useTaskPageJiraCreationState(model: TaskPageGitHubMutationStateModel) {
  const stateModel = useTaskPageJiraCreationStatePrelude(model)
  return useTaskPageJiraCreationProjects(stateModel)
}
export type TaskPageJiraCreationStateModel = ReturnType<typeof useTaskPageJiraCreationState>
