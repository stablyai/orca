import React, { useCallback, useEffect, useMemo } from 'react'

import { filterJiraProjectPickerProjects } from '@/components/jira-project-picker-filter'
import { isVisibleJiraCreateField } from '@/components/task-page-jira-create-fields'
import {
  compareJiraProjectsByDisplayLabel,
  getJiraProjectSelectionKey
} from '@/components/task-page-jira-project-selection'

import type { TaskPageJiraCreationStatePreludeModel } from './use-task-page-jira-creation-state'

export function useTaskPageJiraCreationProjects(model: TaskPageJiraCreationStatePreludeModel) {
  const {
    availableJiraIssueTypes,
    availableJiraProjects,
    jiraCreateFields,
    newJiraIssueCustomFieldValues,
    newJiraIssueProjectComboboxOpen,
    newJiraIssueProjectId,
    newJiraIssueProjectQuery,
    newJiraIssueProjectSearchInputRef,
    newJiraIssueTypeId,
    selectedJiraSiteId,
    setNewJiraIssueProjectComboboxOpen,
    setNewJiraIssueProjectCommandValue,
    setNewJiraIssueProjectId,
    setNewJiraIssueProjectQuery,
    setNewJiraIssueTypeId
  } = model
  const includeJiraSiteNameInProjectLabel = selectedJiraSiteId === 'all'
  const sortedAvailableJiraProjects = useMemo(
    () =>
      [...availableJiraProjects].sort((a, b) =>
        compareJiraProjectsByDisplayLabel(a, b, includeJiraSiteNameInProjectLabel)
      ),
    [availableJiraProjects, includeJiraSiteNameInProjectLabel]
  )
  const filteredNewJiraIssueProjects = useMemo(() => {
    return filterJiraProjectPickerProjects({
      projects: sortedAvailableJiraProjects,
      query: newJiraIssueProjectQuery,
      includeSiteName: includeJiraSiteNameInProjectLabel
    })
  }, [includeJiraSiteNameInProjectLabel, newJiraIssueProjectQuery, sortedAvailableJiraProjects])
  const newJiraIssueTargetProject = useMemo(
    () =>
      sortedAvailableJiraProjects.find(
        (project) => getJiraProjectSelectionKey(project) === newJiraIssueProjectId
      ) ??
      sortedAvailableJiraProjects[0] ??
      null,
    [newJiraIssueProjectId, sortedAvailableJiraProjects]
  )
  const newJiraIssueTargetProjectSelectionKey = newJiraIssueTargetProject
    ? getJiraProjectSelectionKey(newJiraIssueTargetProject)
    : ''
  const newJiraIssueTargetType = useMemo(
    () =>
      availableJiraIssueTypes.find((issueType) => issueType.id === newJiraIssueTypeId) ??
      availableJiraIssueTypes[0] ??
      null,
    [availableJiraIssueTypes, newJiraIssueTypeId]
  )
  const visibleJiraCreateFields = useMemo(
    () => jiraCreateFields.filter(isVisibleJiraCreateField),
    [jiraCreateFields]
  )
  const hasMissingJiraCreateField = useMemo(
    () =>
      visibleJiraCreateFields.some(
        (field) => !(newJiraIssueCustomFieldValues[field.key] ?? '').trim()
      ),
    [newJiraIssueCustomFieldValues, visibleJiraCreateFields]
  )
  useEffect(() => {
    if (!newJiraIssueProjectComboboxOpen) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const input = newJiraIssueProjectSearchInputRef.current
      if (!input) {
        return
      }
      input.focus()
      const end = input.value.length
      input.setSelectionRange(end, end)
    })
    return () => cancelAnimationFrame(frame)
  }, [newJiraIssueProjectComboboxOpen, newJiraIssueProjectSearchInputRef])
  const handleNewJiraIssueProjectComboboxOpenChange = useCallback(
    (open: boolean) => {
      setNewJiraIssueProjectComboboxOpen(open)
      if (open) {
        setNewJiraIssueProjectCommandValue(newJiraIssueTargetProjectSelectionKey)
        return
      }
      setNewJiraIssueProjectQuery('')
    },
    [
      newJiraIssueTargetProjectSelectionKey,
      setNewJiraIssueProjectComboboxOpen,
      setNewJiraIssueProjectCommandValue,
      setNewJiraIssueProjectQuery
    ]
  )
  const handleNewJiraIssueProjectSelect = useCallback(
    (selectionKey: string) => {
      setNewJiraIssueProjectId(selectionKey)
      setNewJiraIssueTypeId(null)
      setNewJiraIssueProjectCommandValue(selectionKey)
      setNewJiraIssueProjectComboboxOpen(false)
      setNewJiraIssueProjectQuery('')
    },
    [
      setNewJiraIssueProjectComboboxOpen,
      setNewJiraIssueProjectCommandValue,
      setNewJiraIssueProjectId,
      setNewJiraIssueProjectQuery,
      setNewJiraIssueTypeId
    ]
  )
  const handleNewJiraIssueProjectTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (newJiraIssueProjectComboboxOpen) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setNewJiraIssueProjectCommandValue(newJiraIssueTargetProjectSelectionKey)
        setNewJiraIssueProjectComboboxOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setNewJiraIssueProjectCommandValue(newJiraIssueTargetProjectSelectionKey)
        setNewJiraIssueProjectQuery(event.key)
        setNewJiraIssueProjectComboboxOpen(true)
      }
    },
    [
      newJiraIssueProjectComboboxOpen,
      newJiraIssueTargetProjectSelectionKey,
      setNewJiraIssueProjectComboboxOpen,
      setNewJiraIssueProjectCommandValue,
      setNewJiraIssueProjectQuery
    ]
  )
  const nextModel = model as typeof model & {
    includeJiraSiteNameInProjectLabel: typeof includeJiraSiteNameInProjectLabel
    sortedAvailableJiraProjects: typeof sortedAvailableJiraProjects
    filteredNewJiraIssueProjects: typeof filteredNewJiraIssueProjects
    newJiraIssueTargetProject: typeof newJiraIssueTargetProject
    newJiraIssueTargetProjectSelectionKey: typeof newJiraIssueTargetProjectSelectionKey
    newJiraIssueTargetType: typeof newJiraIssueTargetType
    visibleJiraCreateFields: typeof visibleJiraCreateFields
    hasMissingJiraCreateField: typeof hasMissingJiraCreateField
    handleNewJiraIssueProjectComboboxOpenChange: typeof handleNewJiraIssueProjectComboboxOpenChange
    handleNewJiraIssueProjectSelect: typeof handleNewJiraIssueProjectSelect
    handleNewJiraIssueProjectTriggerKeyDown: typeof handleNewJiraIssueProjectTriggerKeyDown
  }
  nextModel.includeJiraSiteNameInProjectLabel = includeJiraSiteNameInProjectLabel
  nextModel.sortedAvailableJiraProjects = sortedAvailableJiraProjects
  nextModel.filteredNewJiraIssueProjects = filteredNewJiraIssueProjects
  nextModel.newJiraIssueTargetProject = newJiraIssueTargetProject
  nextModel.newJiraIssueTargetProjectSelectionKey = newJiraIssueTargetProjectSelectionKey
  nextModel.newJiraIssueTargetType = newJiraIssueTargetType
  nextModel.visibleJiraCreateFields = visibleJiraCreateFields
  nextModel.hasMissingJiraCreateField = hasMissingJiraCreateField
  nextModel.handleNewJiraIssueProjectComboboxOpenChange =
    handleNewJiraIssueProjectComboboxOpenChange
  nextModel.handleNewJiraIssueProjectSelect = handleNewJiraIssueProjectSelect
  nextModel.handleNewJiraIssueProjectTriggerKeyDown = handleNewJiraIssueProjectTriggerKeyDown
  return nextModel
}

export type TaskPageJiraCreationProjectsModel = ReturnType<typeof useTaskPageJiraCreationProjects>
