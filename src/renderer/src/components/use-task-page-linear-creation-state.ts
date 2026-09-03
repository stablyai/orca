import type { TaskPageJiraListProjectionModel } from './use-task-page-jira-list-projection'
import { useState, useMemo, useEffect, type SetStateAction } from 'react'
import { useTeamMembers, useTeamLabels, useTeamStates } from '@/hooks/useIssueMetadata'
import { useTaskCreationDraftRetention } from '@/components/use-task-creation-draft-retention'
import type { LinearProjectSummary } from '../../../shared/linear/project-types'
import { linearListProjects } from '@/runtime/runtime-linear-project-client'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { writeNewLinearIssueDraft, writeNewLinearProjectDraft } from './task-page-draft-storage'
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
  // New Linear project dialog state
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
    settings,
    newLinearProjectTargetTeam?.workspaceId
  )
  const newLinearProjectLabels = useTeamLabels(
    newLinearProjectOpen ? (newLinearProjectTargetTeam?.id ?? null) : null,
    settings,
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

  // New Linear issue dialog state
  const [newLinearIssueOpen, setNewLinearIssueOpen] = useState(false)
  const [newLinearIssueTitle, setNewLinearIssueTitle] = useState('')
  const [newLinearIssueBody, setNewLinearIssueBody] = useState('')
  const [newLinearIssueTeamId, setNewLinearIssueTeamIdState] = useState<string | null>(null)
  const [newLinearIssueSubmitting, setNewLinearIssueSubmitting] = useState(false)
  const [newLinearIssueStateId, setNewLinearIssueStateId] = useState<string | null>(null)
  const [newLinearIssueAssigneeId, setNewLinearIssueAssigneeId] = useState<string | null>(null)
  const [newLinearIssuePriority, setNewLinearIssuePriority] = useState<number>(0)
  const [newLinearIssueProjectId, setNewLinearIssueProjectId] = useState<string | null>(null)
  const [newLinearIssueLabelIds, setNewLinearIssueLabelIds] = useState<string[]>([])
  const discardNewLinearIssueDraft = useTaskCreationDraftRetention({
    open: newLinearIssueOpen,
    draft: {
      title: newLinearIssueTitle,
      body: newLinearIssueBody
    },
    writeDraft: writeNewLinearIssueDraft
  })
  const newLinearIssueTargetTeam = useMemo(
    () => availableTeams.find((t) => t.id === newLinearIssueTeamId) ?? availableTeams[0] ?? null,
    [availableTeams, newLinearIssueTeamId]
  )
  const [newLinearIssueProjects, setNewLinearIssueProjects] = useState<LinearProjectSummary[]>([])
  const [newLinearIssueProjectsLoading, setNewLinearIssueProjectsLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!newLinearIssueOpen || !linearConnected || !newLinearIssueTargetTeam) {
      setNewLinearIssueProjects([])
      setNewLinearIssueProjectsLoading(false)
      return
    }
    setNewLinearIssueProjectsLoading(true)
    const targetWorkspaceId =
      newLinearIssueTargetTeam.workspaceId ||
      (selectedLinearWorkspaceId !== 'all' ? selectedLinearWorkspaceId : null)
    linearListProjects(linearTaskSourceContext ?? settings, undefined, 100, targetWorkspaceId)
      .then((p) => {
        if (!cancelled) {
          setNewLinearIssueProjects(p.items)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setNewLinearIssueProjectsLoading(false)
        }
      })
    return () => {
      // Why: project lists are workspace-scoped; stale responses must not populate the composer after a team/workspace switch.
      cancelled = true
    }
  }, [
    linearConnected,
    newLinearIssueOpen,
    newLinearIssueTargetTeam,
    linearTaskSourceContext,
    settings,
    selectedLinearWorkspaceId
  ])
  const setNewLinearIssueTeamId = (value: SetStateAction<string | null>): void => {
    const id = typeof value === 'function' ? value(newLinearIssueTeamId) : value
    setNewLinearIssueTeamIdState(id)
    setNewLinearIssueStateId(null)
    setNewLinearIssueAssigneeId(null)
    setNewLinearIssuePriority(0)
    const targetTeam = availableTeams.find((team) => team.id === id) ?? availableTeams[0]
    setNewLinearIssueProjectId(
      selectedLinearProject?.workspaceId === targetTeam?.workspaceId
        ? (selectedLinearProject?.id ?? null)
        : null
    )
    setNewLinearIssueLabelIds([])
  }
  const newLinearStates = useTeamStates(
    linearConnected ? newLinearIssueTargetTeam?.id || null : null,
    settings,
    newLinearIssueTargetTeam?.workspaceId
  )
  const newLinearMembers = useTeamMembers(
    linearConnected ? newLinearIssueTargetTeam?.id || null : null,
    settings,
    newLinearIssueTargetTeam?.workspaceId
  )
  const newLinearLabels = useTeamLabels(
    linearConnected ? newLinearIssueTargetTeam?.id || null : null,
    settings,
    newLinearIssueTargetTeam?.workspaceId
  )
  useEffect(() => {
    if (newLinearStates.data.length > 0 && !newLinearIssueStateId) {
      const defaultState =
        newLinearStates.data.find((s) => s.type === 'unstarted') || newLinearStates.data[0]
      if (defaultState) {
        setNewLinearIssueStateId(defaultState.id)
      }
    }
  }, [newLinearStates.data, newLinearIssueStateId])
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
  const nextModel = model as typeof model & {
    newLinearProjectOpen: typeof newLinearProjectOpen
    setNewLinearProjectOpen: typeof setNewLinearProjectOpen
    newLinearProjectName: typeof newLinearProjectName
    setNewLinearProjectName: typeof setNewLinearProjectName
    newLinearProjectDescription: typeof newLinearProjectDescription
    setNewLinearProjectDescription: typeof setNewLinearProjectDescription
    newLinearProjectContent: typeof newLinearProjectContent
    setNewLinearProjectContent: typeof setNewLinearProjectContent
    newLinearProjectTeamId: typeof newLinearProjectTeamId
    setNewLinearProjectTeamId: typeof setNewLinearProjectTeamId
    newLinearProjectLeadId: typeof newLinearProjectLeadId
    setNewLinearProjectLeadId: typeof setNewLinearProjectLeadId
    newLinearProjectMemberIds: typeof newLinearProjectMemberIds
    setNewLinearProjectMemberIds: typeof setNewLinearProjectMemberIds
    newLinearProjectLabelIds: typeof newLinearProjectLabelIds
    setNewLinearProjectLabelIds: typeof setNewLinearProjectLabelIds
    newLinearProjectPriority: typeof newLinearProjectPriority
    setNewLinearProjectPriority: typeof setNewLinearProjectPriority
    newLinearProjectStartDate: typeof newLinearProjectStartDate
    setNewLinearProjectStartDate: typeof setNewLinearProjectStartDate
    newLinearProjectTargetDate: typeof newLinearProjectTargetDate
    setNewLinearProjectTargetDate: typeof setNewLinearProjectTargetDate
    newLinearProjectSubmitting: typeof newLinearProjectSubmitting
    setNewLinearProjectSubmitting: typeof setNewLinearProjectSubmitting
    newLinearProjectTargetTeam: typeof newLinearProjectTargetTeam
    newLinearProjectMembers: typeof newLinearProjectMembers
    newLinearProjectLabels: typeof newLinearProjectLabels
    discardNewLinearProjectDraft: typeof discardNewLinearProjectDraft
    newLinearIssueOpen: typeof newLinearIssueOpen
    setNewLinearIssueOpen: typeof setNewLinearIssueOpen
    newLinearIssueTitle: typeof newLinearIssueTitle
    setNewLinearIssueTitle: typeof setNewLinearIssueTitle
    newLinearIssueBody: typeof newLinearIssueBody
    setNewLinearIssueBody: typeof setNewLinearIssueBody
    newLinearIssueTeamId: typeof newLinearIssueTeamId
    setNewLinearIssueTeamId: typeof setNewLinearIssueTeamId
    newLinearIssueSubmitting: typeof newLinearIssueSubmitting
    setNewLinearIssueSubmitting: typeof setNewLinearIssueSubmitting
    newLinearIssueStateId: typeof newLinearIssueStateId
    setNewLinearIssueStateId: typeof setNewLinearIssueStateId
    newLinearIssueAssigneeId: typeof newLinearIssueAssigneeId
    setNewLinearIssueAssigneeId: typeof setNewLinearIssueAssigneeId
    newLinearIssuePriority: typeof newLinearIssuePriority
    setNewLinearIssuePriority: typeof setNewLinearIssuePriority
    newLinearIssueProjectId: typeof newLinearIssueProjectId
    setNewLinearIssueProjectId: typeof setNewLinearIssueProjectId
    newLinearIssueLabelIds: typeof newLinearIssueLabelIds
    setNewLinearIssueLabelIds: typeof setNewLinearIssueLabelIds
    discardNewLinearIssueDraft: typeof discardNewLinearIssueDraft
    newLinearIssueTargetTeam: typeof newLinearIssueTargetTeam
    newLinearIssueProjects: typeof newLinearIssueProjects
    setNewLinearIssueProjects: typeof setNewLinearIssueProjects
    newLinearIssueProjectsLoading: typeof newLinearIssueProjectsLoading
    setNewLinearIssueProjectsLoading: typeof setNewLinearIssueProjectsLoading
    newLinearStates: typeof newLinearStates
    newLinearMembers: typeof newLinearMembers
    newLinearLabels: typeof newLinearLabels
    linearConnectOpen: typeof linearConnectOpen
    setLinearConnectOpen: typeof setLinearConnectOpen
    jiraConnectOpen: typeof jiraConnectOpen
    setJiraConnectOpen: typeof setJiraConnectOpen
  }
  nextModel.newLinearProjectOpen = newLinearProjectOpen
  nextModel.setNewLinearProjectOpen = setNewLinearProjectOpen
  nextModel.newLinearProjectName = newLinearProjectName
  nextModel.setNewLinearProjectName = setNewLinearProjectName
  nextModel.newLinearProjectDescription = newLinearProjectDescription
  nextModel.setNewLinearProjectDescription = setNewLinearProjectDescription
  nextModel.newLinearProjectContent = newLinearProjectContent
  nextModel.setNewLinearProjectContent = setNewLinearProjectContent
  nextModel.newLinearProjectTeamId = newLinearProjectTeamId
  nextModel.setNewLinearProjectTeamId = setNewLinearProjectTeamId
  nextModel.newLinearProjectLeadId = newLinearProjectLeadId
  nextModel.setNewLinearProjectLeadId = setNewLinearProjectLeadId
  nextModel.newLinearProjectMemberIds = newLinearProjectMemberIds
  nextModel.setNewLinearProjectMemberIds = setNewLinearProjectMemberIds
  nextModel.newLinearProjectLabelIds = newLinearProjectLabelIds
  nextModel.setNewLinearProjectLabelIds = setNewLinearProjectLabelIds
  nextModel.newLinearProjectPriority = newLinearProjectPriority
  nextModel.setNewLinearProjectPriority = setNewLinearProjectPriority
  nextModel.newLinearProjectStartDate = newLinearProjectStartDate
  nextModel.setNewLinearProjectStartDate = setNewLinearProjectStartDate
  nextModel.newLinearProjectTargetDate = newLinearProjectTargetDate
  nextModel.setNewLinearProjectTargetDate = setNewLinearProjectTargetDate
  nextModel.newLinearProjectSubmitting = newLinearProjectSubmitting
  nextModel.setNewLinearProjectSubmitting = setNewLinearProjectSubmitting
  nextModel.newLinearProjectTargetTeam = newLinearProjectTargetTeam
  nextModel.newLinearProjectMembers = newLinearProjectMembers
  nextModel.newLinearProjectLabels = newLinearProjectLabels
  nextModel.discardNewLinearProjectDraft = discardNewLinearProjectDraft
  nextModel.newLinearIssueOpen = newLinearIssueOpen
  nextModel.setNewLinearIssueOpen = setNewLinearIssueOpen
  nextModel.newLinearIssueTitle = newLinearIssueTitle
  nextModel.setNewLinearIssueTitle = setNewLinearIssueTitle
  nextModel.newLinearIssueBody = newLinearIssueBody
  nextModel.setNewLinearIssueBody = setNewLinearIssueBody
  nextModel.newLinearIssueTeamId = newLinearIssueTeamId
  nextModel.setNewLinearIssueTeamId = setNewLinearIssueTeamId
  nextModel.newLinearIssueSubmitting = newLinearIssueSubmitting
  nextModel.setNewLinearIssueSubmitting = setNewLinearIssueSubmitting
  nextModel.newLinearIssueStateId = newLinearIssueStateId
  nextModel.setNewLinearIssueStateId = setNewLinearIssueStateId
  nextModel.newLinearIssueAssigneeId = newLinearIssueAssigneeId
  nextModel.setNewLinearIssueAssigneeId = setNewLinearIssueAssigneeId
  nextModel.newLinearIssuePriority = newLinearIssuePriority
  nextModel.setNewLinearIssuePriority = setNewLinearIssuePriority
  nextModel.newLinearIssueProjectId = newLinearIssueProjectId
  nextModel.setNewLinearIssueProjectId = setNewLinearIssueProjectId
  nextModel.newLinearIssueLabelIds = newLinearIssueLabelIds
  nextModel.setNewLinearIssueLabelIds = setNewLinearIssueLabelIds
  nextModel.discardNewLinearIssueDraft = discardNewLinearIssueDraft
  nextModel.newLinearIssueTargetTeam = newLinearIssueTargetTeam
  nextModel.newLinearIssueProjects = newLinearIssueProjects
  nextModel.setNewLinearIssueProjects = setNewLinearIssueProjects
  nextModel.newLinearIssueProjectsLoading = newLinearIssueProjectsLoading
  nextModel.setNewLinearIssueProjectsLoading = setNewLinearIssueProjectsLoading
  nextModel.newLinearStates = newLinearStates
  nextModel.newLinearMembers = newLinearMembers
  nextModel.newLinearLabels = newLinearLabels
  nextModel.linearConnectOpen = linearConnectOpen
  nextModel.setLinearConnectOpen = setLinearConnectOpen
  Object.assign(nextModel, { jiraConnectOpen, setJiraConnectOpen })
  return nextModel
}
export type TaskPageLinearCreationStateModel = ReturnType<typeof useTaskPageLinearCreationState>
