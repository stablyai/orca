import type { TaskPageJiraListProjectionModel } from '../../use-task-page-jira-list-projection'
import { useState, useMemo, useEffect, useReducer, type SetStateAction } from 'react'
import { useTeamMembers, useTeamLabels, useTeamStates } from '@/hooks/useIssueMetadata'
import {
  useTaskCreationDraftRetention,
  type LinearIssueForm,
  linearIssueFormPickerDefaults as pickerDefaults,
  sameLinearIssueFormSignature as sameSignature,
  linearIssueFormSignature as signatureOf,
  completeLinearIssueForm,
  handoffLinearIssueForm as handoff
} from '@/components/use-task-creation-draft-retention'
import { useNewLinearIssueProjects } from '../../use-new-linear-issue-projects'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { writeNewLinearIssueDraft, writeNewLinearProjectDraft } from '../task-page-draft-storage'
import { defaultScopeSource } from '@/lib/default-creation-host'
type FormAction = (value: LinearIssueForm, target: string) => LinearIssueForm
export function useLinearIssueCreationForm(
  runtime: string,
  initial = { open: false, title: '', body: '' }
) {
  const [form, update] = useReducer(
    (previous: LinearIssueForm, action: FormAction) => action(previous, runtime),
    {
      ...initial,
      ...pickerDefaults,
      runtime,
      attempt: null,
      occurrence: {},
      titleContributor: {},
      bodyContributor: {},
      retirement: null
    }
  )
  const retention = useTaskCreationDraftRetention({
    open: form.open,
    signature: form.open ? form : (form.retirement ?? form),
    sameSignature,
    draft: {
      title: (form.open ? form : (form.retirement ?? form)).title,
      body: (form.open ? form : (form.retirement ?? form)).body
    },
    writeDraft: writeNewLinearIssueDraft
  })
  const commands = useMemo(() => {
    const field =
      <
        K extends keyof Pick<
          LinearIssueForm,
          'open' | 'title' | 'body' | keyof typeof pickerDefaults
        >
      >(
        key: K
      ) =>
      (value: SetStateAction<LinearIssueForm[K]>) => {
        const contribution = {}
        update((current, target) => {
          if (current.runtime !== runtime && target !== runtime) {
            return current
          }
          const previous = current.runtime === runtime ? current : handoff(current, runtime)
          const next = typeof value === 'function' ? value(previous[key]) : value
          if (Object.is(next, previous[key])) {
            return previous
          }
          return {
            ...previous,
            runtime,
            [key]: next,
            occurrence: key === 'open' && next ? contribution : previous.occurrence,
            titleContributor: key === 'title' ? contribution : previous.titleContributor,
            bodyContributor: key === 'body' ? contribution : previous.bodyContributor,
            retirement: key === 'open' ? (next ? null : signatureOf(previous)) : previous.retirement
          }
        })
      }
    return {
      setNewLinearIssueOpen: field('open'),
      setNewLinearIssueTitle: field('title'),
      setNewLinearIssueBody: field('body'),
      setNewLinearIssueStateId: field('stateId'),
      setNewLinearIssueAssigneeId: field('assigneeId'),
      setNewLinearIssuePriority: field('priority'),
      setNewLinearIssueProjectId: field('projectId'),
      setNewLinearIssueLabelIds: field('labelIds'),
      completeNewLinearIssueDraft(submitted: ReturnType<typeof retention.capture>) {
        retention.complete(submitted)
        update((previous, target) =>
          completeLinearIssueForm(previous, runtime, target, submitted.signature)
        )
      },
      beginNewLinearIssue: (attempt: NonNullable<LinearIssueForm['attempt']>) =>
        update((previous, target) =>
          target === runtime ? { ...handoff(previous, runtime), attempt } : previous
        ),
      settleNewLinearIssue: (attempt: NonNullable<LinearIssueForm['attempt']>) =>
        update((previous, target) =>
          target === runtime && previous.runtime === runtime && previous.attempt === attempt
            ? { ...previous, attempt: null }
            : previous
        ),
      resetNewLinearIssue: () =>
        update((previous, target) => (target === runtime ? handoff(previous, runtime) : previous))
    }
  }, [retention, runtime])
  return {
    ...commands,
    newLinearIssueOpen: form.open,
    newLinearIssueTitle: form.title,
    newLinearIssueBody: form.body,
    newLinearIssueSubmitting: form.attempt !== null,
    newLinearIssueStateId: form.stateId,
    newLinearIssueAssigneeId: form.assigneeId,
    newLinearIssuePriority: form.priority,
    newLinearIssueProjectId: form.projectId,
    newLinearIssueLabelIds: form.labelIds,
    captureNewLinearIssueDraft: retention.capture
  }
}
export function useTaskPageLinearCreationState(model: TaskPageJiraListProjectionModel) {
  const {
    settings,
    activeModal,
    linearConnected,
    selectedLinearWorkspaceId,
    linearTaskSourceContext,
    gitlabDialogItem,
    dialogWorkItem,
    newIssueOpen,
    selectedLinearIssue,
    selectedLinearProject,
    availableTeams
  } = model
  const [newLinearProjectOpen, setNewLinearProjectOpen] = useState(false)
  const [newLinearProjectName, setNewLinearProjectName] = useState('')
  const [newLinearProjectDescription, setNewLinearProjectDescription] = useState('')
  const [newLinearProjectContent, setNewLinearProjectContent] = useState('')
  const [newLinearProjectTeamId, setNewLinearProjectTeamIdState] = useState<string | null>(null)
  const [newLinearProjectLeadId, setNewLinearProjectLeadId] = useState<string | null>(null)
  const [newLinearProjectMemberIds, setNewLinearProjectMemberIds] = useState<string[]>([])
  const [newLinearProjectLabelIds, setNewLinearProjectLabelIds] = useState<string[]>([])
  const [newLinearProjectPriority, setNewLinearProjectPriority] = useState<number>(0)
  const [newLinearProjectStartDate, setNewLinearProjectStartDate] = useState('')
  const [newLinearProjectTargetDate, setNewLinearProjectTargetDate] = useState('')
  const [newLinearProjectSubmitting, setNewLinearProjectSubmitting] = useState(false)
  const newLinearProjectTargetTeam = useMemo(
    () => availableTeams.find((t) => t.id === newLinearProjectTeamId) ?? availableTeams[0] ?? null,
    [availableTeams, newLinearProjectTeamId]
  )
  const newLinearProjectMembers = useTeamMembers(
    newLinearProjectOpen ? (newLinearProjectTargetTeam?.id ?? null) : null,
    defaultScopeSource(settings),
    newLinearProjectTargetTeam?.workspaceId
  )
  const newLinearProjectLabels = useTeamLabels(
    newLinearProjectOpen ? (newLinearProjectTargetTeam?.id ?? null) : null,
    defaultScopeSource(settings),
    newLinearProjectTargetTeam?.workspaceId
  )
  const setNewLinearProjectTeamId = (id: string | null): void => {
    setNewLinearProjectTeamIdState(id)
    setNewLinearProjectLeadId(null)
    setNewLinearProjectMemberIds([])
    setNewLinearProjectLabelIds([])
  }
  const discardNewLinearProjectDraft = useTaskCreationDraftRetention({
    open: newLinearProjectOpen,
    draft: {
      name: newLinearProjectName,
      description: newLinearProjectDescription,
      content: newLinearProjectContent
    },
    writeDraft: writeNewLinearProjectDraft
  })

  const issueForm = useLinearIssueCreationForm(model.providerRuntimeContextKey)
  const { newLinearIssueOpen, newLinearIssueStateId, setNewLinearIssueStateId } = issueForm
  const [newLinearIssueTeamId, setNewLinearIssueTeamIdState] = useState<string | null>(null)
  const newLinearIssueTargetTeam = useMemo(
    () => availableTeams.find((t) => t.id === newLinearIssueTeamId) ?? availableTeams[0] ?? null,
    [availableTeams, newLinearIssueTeamId]
  )
  const {
    newLinearIssueProjects,
    setNewLinearIssueProjects,
    newLinearIssueProjectsLoading,
    setNewLinearIssueProjectsLoading
  } = useNewLinearIssueProjects({
    open: newLinearIssueOpen && linearConnected,
    targetTeam: newLinearIssueTargetTeam,
    selectedLinearWorkspaceId,
    linearTaskSourceContext,
    settings
  })
  const setNewLinearIssueTeamId = (value: SetStateAction<string | null>): void => {
    const id = typeof value === 'function' ? value(newLinearIssueTeamId) : value
    setNewLinearIssueTeamIdState(id)
    setNewLinearIssueStateId(null)
    issueForm.setNewLinearIssueAssigneeId(null)
    issueForm.setNewLinearIssuePriority(0)
    const targetTeam = availableTeams.find((team) => team.id === id) ?? availableTeams[0]
    issueForm.setNewLinearIssueProjectId(
      selectedLinearProject?.workspaceId === targetTeam?.workspaceId
        ? (selectedLinearProject?.id ?? null)
        : null
    )
    issueForm.setNewLinearIssueLabelIds([])
  }
  const newLinearStates = useTeamStates(
    linearConnected ? newLinearIssueTargetTeam?.id || null : null,
    defaultScopeSource(settings),
    newLinearIssueTargetTeam?.workspaceId
  )
  const newLinearMembers = useTeamMembers(
    linearConnected ? newLinearIssueTargetTeam?.id || null : null,
    defaultScopeSource(settings),
    newLinearIssueTargetTeam?.workspaceId
  )
  const newLinearLabels = useTeamLabels(
    linearConnected ? newLinearIssueTargetTeam?.id || null : null,
    defaultScopeSource(settings),
    newLinearIssueTargetTeam?.workspaceId
  )
  useEffect(() => {
    const defaultState =
      newLinearStates.data.find((s) => s.type === 'unstarted') ?? newLinearStates.data[0]
    if (!newLinearIssueStateId && defaultState) {
      setNewLinearIssueStateId(defaultState.id)
    }
  }, [newLinearStates.data, newLinearIssueStateId, setNewLinearIssueStateId])
  const [linearConnectOpen, setLinearConnectOpen] = useState(false)
  const [jiraConnectOpen, setJiraConnectOpen] = useState(false)
  useContextualTour(
    'tasks',
    !dialogWorkItem &&
      !gitlabDialogItem &&
      !selectedLinearIssue &&
      !newIssueOpen &&
      !newLinearProjectOpen &&
      !newLinearIssueOpen &&
      !linearConnectOpen &&
      !jiraConnectOpen &&
      activeModal === 'none',
    'tasks_open'
  )
  return Object.assign(model, issueForm, {
    resetNewLinearIssue: () => {
      issueForm.resetNewLinearIssue()
      if (newLinearIssueOpen) {
        setNewLinearIssueTeamIdState(null)
      }
    },
    newLinearProjectOpen,
    setNewLinearProjectOpen,
    newLinearProjectName,
    setNewLinearProjectName,
    newLinearProjectDescription,
    setNewLinearProjectDescription,
    newLinearProjectContent,
    setNewLinearProjectContent,
    newLinearProjectTeamId,
    setNewLinearProjectTeamId,
    newLinearProjectLeadId,
    setNewLinearProjectLeadId,
    newLinearProjectMemberIds,
    setNewLinearProjectMemberIds,
    newLinearProjectLabelIds,
    setNewLinearProjectLabelIds,
    newLinearProjectPriority,
    setNewLinearProjectPriority,
    newLinearProjectStartDate,
    setNewLinearProjectStartDate,
    newLinearProjectTargetDate,
    setNewLinearProjectTargetDate,
    newLinearProjectSubmitting,
    setNewLinearProjectSubmitting,
    newLinearProjectTargetTeam,
    newLinearProjectMembers,
    newLinearProjectLabels,
    discardNewLinearProjectDraft,
    newLinearIssueTeamId,
    setNewLinearIssueTeamId,
    newLinearIssueTargetTeam,
    newLinearIssueProjects,
    setNewLinearIssueProjects,
    newLinearIssueProjectsLoading,
    setNewLinearIssueProjectsLoading,
    newLinearStates,
    newLinearMembers,
    newLinearLabels,
    linearConnectOpen,
    setLinearConnectOpen,
    jiraConnectOpen,
    setJiraConnectOpen
  })
}
export type TaskPageLinearCreationStateModel = ReturnType<typeof useTaskPageLinearCreationState>
