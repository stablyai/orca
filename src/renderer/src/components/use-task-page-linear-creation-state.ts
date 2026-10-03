import type { TaskPageBusinessmapListProjectionModel } from './use-task-page-businessmap-list-projection'
import { useState, useMemo, useEffect, type SetStateAction } from 'react'
import { useTeamMembers, useTeamLabels, useTeamStates } from '@/hooks/useIssueMetadata'
import { useTaskPageLinearProjectDraftState } from './use-task-page-linear-project-draft-state'
import { useTaskCreationDraftRetention } from '@/components/use-task-creation-draft-retention'
import type { LinearProjectSummary } from '../../../shared/linear/project-types'
import { linearListProjects } from '@/runtime/runtime-linear-project-client'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { writeNewLinearIssueDraft } from './task-page-draft-storage'
export function useTaskPageLinearCreationState(model: TaskPageBusinessmapListProjectionModel) {
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
  const linearProjectDraft = useTaskPageLinearProjectDraftState({ settings, availableTeams })
  const { newLinearProjectOpen } = linearProjectDraft

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
  const [businessmapConnectOpen, setBusinessmapConnectOpen] = useState(false)
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
      !businessmapConnectOpen &&
      activeModal === 'none',
    'tasks_open'
  )
  const nextModel = model as typeof model & {
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
    businessmapConnectOpen: typeof businessmapConnectOpen
    setBusinessmapConnectOpen: typeof setBusinessmapConnectOpen
  } & typeof linearProjectDraft
  Object.assign(nextModel, linearProjectDraft)
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
  Object.assign(nextModel, {
    jiraConnectOpen,
    setJiraConnectOpen,
    businessmapConnectOpen,
    setBusinessmapConnectOpen
  })
  return nextModel
}
export type TaskPageLinearCreationStateModel = ReturnType<typeof useTaskPageLinearCreationState>
