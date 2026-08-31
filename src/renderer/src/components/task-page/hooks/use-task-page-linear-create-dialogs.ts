import { useEffect, useMemo, useState, type SetStateAction } from 'react'

import { useTaskCreationDraftRetention } from '@/components/use-task-creation-draft-retention'
import { useTeamLabels, useTeamMembers, useTeamStates } from '@/hooks/useIssueMetadata'
import { linearListProjects } from '@/runtime/runtime-linear-project-client'
import {
  writeNewLinearIssueDraft,
  writeNewLinearProjectDraft
} from '@/components/task-page/dialogs/task-creation-draft-writers'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { LinearProjectSummary } from '../../../../../shared/linear/project-types'
import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function useTaskPageLinearCreateDialogs({
  availableTeams,
  settings,
  linearConnected,
  selectedLinearWorkspaceId,
  linearTaskSourceContext,
  selectedLinearProject
}: {
  availableTeams: LinearTeam[]
  settings: GlobalSettings | null
  linearConnected: boolean
  selectedLinearWorkspaceId: string | null
  linearTaskSourceContext: TaskSourceContext | null
  selectedLinearProject: LinearProjectSummary | null
}) {
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
    draft: { title: newLinearIssueTitle, body: newLinearIssueBody },
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
      .catch((err) => {
        console.warn('[TaskPage] Failed to load Linear projects for the issue composer', err)
      })
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

  return {
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
    newLinearIssueOpen,
    setNewLinearIssueOpen,
    newLinearIssueTitle,
    setNewLinearIssueTitle,
    newLinearIssueBody,
    setNewLinearIssueBody,
    newLinearIssueTeamId,
    setNewLinearIssueTeamId,
    newLinearIssueSubmitting,
    setNewLinearIssueSubmitting,
    newLinearIssueStateId,
    setNewLinearIssueStateId,
    newLinearIssueAssigneeId,
    setNewLinearIssueAssigneeId,
    newLinearIssuePriority,
    setNewLinearIssuePriority,
    newLinearIssueProjectId,
    setNewLinearIssueProjectId,
    newLinearIssueLabelIds,
    setNewLinearIssueLabelIds,
    discardNewLinearIssueDraft,
    newLinearIssueTargetTeam,
    newLinearIssueProjects,
    setNewLinearIssueProjects,
    newLinearIssueProjectsLoading,
    setNewLinearIssueProjectsLoading,
    newLinearStates,
    newLinearMembers,
    newLinearLabels,
    linearConnectOpen,
    setLinearConnectOpen
  }
}
