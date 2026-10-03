import { useMemo, useState } from 'react'
import { useTeamMembers, useTeamLabels } from '@/hooks/useIssueMetadata'
import { useTaskCreationDraftRetention } from '@/components/use-task-creation-draft-retention'
import type { TaskPageBusinessmapListProjectionModel } from './use-task-page-businessmap-list-projection'
import { writeNewLinearProjectDraft } from './task-page-draft-storage'

export function useTaskPageLinearProjectDraftState({
  settings,
  availableTeams
}: Pick<TaskPageBusinessmapListProjectionModel, 'settings' | 'availableTeams'>) {
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
    discardNewLinearProjectDraft
  }
}
