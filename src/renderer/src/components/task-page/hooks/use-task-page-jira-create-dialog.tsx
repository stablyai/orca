import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { filterJiraProjectPickerProjects } from '@/components/jira-project-picker-filter'
import { useTaskCreationDraftRetention } from '@/components/use-task-creation-draft-retention'
import { translate } from '@/i18n/i18n'
import { jiraListCreateFields, jiraListIssueTypes } from '@/runtime/runtime-jira-client'
import {
  compareJiraProjectsByDisplayLabel,
  getJiraProjectSelectionKey
} from '@/components/task-page-jira-project-selection'
import { isVisibleJiraCreateField } from '@/components/task-page-jira-create-fields'
import { writeNewJiraIssueDraft } from '@/components/task-page/dialogs/task-creation-draft-writers'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type {
  JiraCreateField,
  JiraIssueType,
  JiraProject,
  JiraSiteSelection
} from '../../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function useTaskPageJiraCreateDialog({
  selectedJiraSiteId,
  availableJiraProjects,
  jiraConnected,
  settings,
  jiraTaskSourceContext
}: {
  selectedJiraSiteId: JiraSiteSelection | null
  availableJiraProjects: JiraProject[]
  jiraConnected: boolean
  settings: GlobalSettings | null
  jiraTaskSourceContext: TaskSourceContext | null
}) {
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
    draft: { title: newJiraIssueTitle, body: newJiraIssueBody },
    writeDraft: writeNewJiraIssueDraft
  })
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
  }, [newJiraIssueProjectComboboxOpen])

  const handleNewJiraIssueProjectComboboxOpenChange = useCallback(
    (open: boolean) => {
      setNewJiraIssueProjectComboboxOpen(open)
      if (open) {
        setNewJiraIssueProjectCommandValue(newJiraIssueTargetProjectSelectionKey)
        return
      }
      setNewJiraIssueProjectQuery('')
    },
    [newJiraIssueTargetProjectSelectionKey]
  )

  const handleNewJiraIssueProjectSelect = useCallback((selectionKey: string) => {
    setNewJiraIssueProjectId(selectionKey)
    setNewJiraIssueTypeId(null)
    setNewJiraIssueProjectCommandValue(selectionKey)
    setNewJiraIssueProjectComboboxOpen(false)
    setNewJiraIssueProjectQuery('')
  }, [])

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
    [newJiraIssueProjectComboboxOpen, newJiraIssueTargetProjectSelectionKey]
  )

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
  }, [settings, jiraConnected, newJiraIssueOpen, newJiraIssueTargetProject, jiraTaskSourceContext])

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
    jiraTaskSourceContext
  ])

  return {
    newJiraIssueOpen,
    setNewJiraIssueOpen,
    newJiraIssueTitle,
    setNewJiraIssueTitle,
    newJiraIssueBody,
    setNewJiraIssueBody,
    newJiraIssueProjectId,
    setNewJiraIssueProjectId,
    newJiraIssueProjectComboboxOpen,
    setNewJiraIssueProjectComboboxOpen,
    newJiraIssueProjectQuery,
    setNewJiraIssueProjectQuery,
    newJiraIssueProjectCommandValue,
    setNewJiraIssueProjectCommandValue,
    newJiraIssueTypeId,
    setNewJiraIssueTypeId,
    newJiraIssueSubmitting,
    setNewJiraIssueSubmitting,
    newJiraIssueProjectSearchInputRef,
    availableJiraIssueTypes,
    setAvailableJiraIssueTypes,
    jiraIssueTypesLoading,
    setJiraIssueTypesLoading,
    jiraCreateFields,
    setJiraCreateFields,
    jiraCreateFieldsLoading,
    setJiraCreateFieldsLoading,
    jiraCreateFieldsError,
    setJiraCreateFieldsError,
    newJiraIssueCustomFieldValues,
    setNewJiraIssueCustomFieldValues,
    discardNewJiraIssueDraft,
    includeJiraSiteNameInProjectLabel,
    sortedAvailableJiraProjects,
    filteredNewJiraIssueProjects,
    newJiraIssueTargetProject,
    newJiraIssueTargetProjectSelectionKey,
    newJiraIssueTargetType,
    visibleJiraCreateFields,
    hasMissingJiraCreateField,
    handleNewJiraIssueProjectComboboxOpenChange,
    handleNewJiraIssueProjectSelect,
    handleNewJiraIssueProjectTriggerKeyDown
  }
}
