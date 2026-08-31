import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { linearCreateIssue, linearGetIssue } from '@/runtime/runtime-linear-issue-mutations'
import { linearCreateProject } from '@/runtime/runtime-linear-project-client'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearTeam
} from '../../../../../shared/linear/workspace-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function useTaskPageCreateLinearSubmits({
  newLinearProjectTargetTeam,
  newLinearProjectName,
  newLinearProjectSubmitting,
  linearTaskSourceContext,
  settings,
  newLinearProjectDescription,
  newLinearProjectContent,
  newLinearProjectLeadId,
  newLinearProjectMemberIds,
  newLinearProjectLabelIds,
  newLinearProjectPriority,
  newLinearProjectStartDate,
  newLinearProjectTargetDate,
  discardNewLinearProjectDraft,
  setNewLinearProjectSubmitting,
  setNewLinearProjectOpen,
  setNewLinearProjectName,
  setNewLinearProjectDescription,
  setNewLinearProjectContent,
  setNewLinearProjectLeadId,
  setNewLinearProjectMemberIds,
  setNewLinearProjectLabelIds,
  setNewLinearProjectPriority,
  setNewLinearProjectStartDate,
  setNewLinearProjectTargetDate,
  setAppliedLinearProjectSearch,
  setLinearProjectSearchInput,
  setLinearProjectsResult,
  setSelectedLinearProjectDetail,
  openLinearProjectContext,
  setLinearRefreshNonce,
  newLinearIssueTargetTeam,
  newLinearIssueTitle,
  newLinearIssueSubmitting,
  selectedLinearProject,
  newLinearIssueProjectId,
  providerRuntimeContextKey,
  providerRuntimeContextKeyRef,
  newLinearIssueBody,
  newLinearIssueStateId,
  newLinearIssuePriority,
  newLinearIssueAssigneeId,
  newLinearIssueLabelIds,
  discardNewLinearIssueDraft,
  setNewLinearIssueSubmitting,
  setNewLinearIssueOpen,
  setNewLinearIssueTitle,
  setNewLinearIssueBody,
  setNewLinearIssueStateId,
  setNewLinearIssueAssigneeId,
  setNewLinearIssuePriority,
  setNewLinearIssueProjectId,
  setNewLinearIssueLabelIds,
  setSelectedLinearIssue
}: {
  newLinearProjectTargetTeam: LinearTeam | null
  newLinearProjectName: string
  newLinearProjectSubmitting: boolean
  linearTaskSourceContext: TaskSourceContext | null
  settings: GlobalSettings | null
  newLinearProjectDescription: string
  newLinearProjectContent: string
  newLinearProjectLeadId: string | null
  newLinearProjectMemberIds: string[]
  newLinearProjectLabelIds: string[]
  newLinearProjectPriority: number
  newLinearProjectStartDate: string
  newLinearProjectTargetDate: string
  discardNewLinearProjectDraft: () => void
  setNewLinearProjectSubmitting: Dispatch<SetStateAction<boolean>>
  setNewLinearProjectOpen: Dispatch<SetStateAction<boolean>>
  setNewLinearProjectName: Dispatch<SetStateAction<string>>
  setNewLinearProjectDescription: Dispatch<SetStateAction<string>>
  setNewLinearProjectContent: Dispatch<SetStateAction<string>>
  setNewLinearProjectLeadId: Dispatch<SetStateAction<string | null>>
  setNewLinearProjectMemberIds: Dispatch<SetStateAction<string[]>>
  setNewLinearProjectLabelIds: Dispatch<SetStateAction<string[]>>
  setNewLinearProjectPriority: Dispatch<SetStateAction<number>>
  setNewLinearProjectStartDate: Dispatch<SetStateAction<string>>
  setNewLinearProjectTargetDate: Dispatch<SetStateAction<string>>
  setAppliedLinearProjectSearch: Dispatch<SetStateAction<string>>
  setLinearProjectSearchInput: Dispatch<SetStateAction<string>>
  setLinearProjectsResult: Dispatch<SetStateAction<LinearCollectionResult<LinearProjectSummary>>>
  setSelectedLinearProjectDetail: Dispatch<SetStateAction<LinearProjectDetail | null>>
  openLinearProjectContext: (project: LinearProjectSummary) => void
  setLinearRefreshNonce: Dispatch<SetStateAction<number>>
  newLinearIssueTargetTeam: LinearTeam | null
  newLinearIssueTitle: string
  newLinearIssueSubmitting: boolean
  selectedLinearProject: LinearProjectSummary | null
  newLinearIssueProjectId: string | null
  providerRuntimeContextKey: string
  providerRuntimeContextKeyRef: { current: string }
  newLinearIssueBody: string
  newLinearIssueStateId: string | null
  newLinearIssuePriority: number
  newLinearIssueAssigneeId: string | null
  newLinearIssueLabelIds: string[]
  discardNewLinearIssueDraft: () => void
  setNewLinearIssueSubmitting: Dispatch<SetStateAction<boolean>>
  setNewLinearIssueOpen: Dispatch<SetStateAction<boolean>>
  setNewLinearIssueTitle: Dispatch<SetStateAction<string>>
  setNewLinearIssueBody: Dispatch<SetStateAction<string>>
  setNewLinearIssueStateId: Dispatch<SetStateAction<string | null>>
  setNewLinearIssueAssigneeId: Dispatch<SetStateAction<string | null>>
  setNewLinearIssuePriority: Dispatch<SetStateAction<number>>
  setNewLinearIssueProjectId: Dispatch<SetStateAction<string | null>>
  setNewLinearIssueLabelIds: Dispatch<SetStateAction<string[]>>
  setSelectedLinearIssue: (
    issue: LinearIssue | null,
    options?: { allowOutsideList?: boolean }
  ) => void
}) {
  const handleCreateNewLinearProject = useCallback(async (): Promise<void> => {
    if (!newLinearProjectTargetTeam) {
      return
    }
    const name = newLinearProjectName.trim()
    if (!name || newLinearProjectSubmitting) {
      return
    }
    setNewLinearProjectSubmitting(true)
    try {
      const result = await linearCreateProject(linearTaskSourceContext ?? settings, {
        name,
        description: newLinearProjectDescription.trim() || undefined,
        content: newLinearProjectContent.trim() || undefined,
        teamIds: [newLinearProjectTargetTeam.id],
        workspaceId: newLinearProjectTargetTeam.workspaceId,
        leadId: newLinearProjectLeadId || undefined,
        memberIds: newLinearProjectMemberIds.length > 0 ? newLinearProjectMemberIds : undefined,
        labelIds: newLinearProjectLabelIds.length > 0 ? newLinearProjectLabelIds : undefined,
        priority: newLinearProjectPriority,
        startDate: newLinearProjectStartDate || undefined,
        targetDate: newLinearProjectTargetDate || undefined
      })
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.TaskPage.3ca9b424a3', 'Failed to create project.')
        )
        return
      }
      toast.success(
        translate('auto.components.TaskPage.cb98f0350c', 'Created {{value0}}', {
          value0: result.project.name
        }),
        {
          action: result.project.url
            ? {
                label: translate('auto.components.TaskPage.9c57663908', 'View'),
                onClick: () => window.open(result.project.url, '_blank')
              }
            : undefined
        }
      )
      discardNewLinearProjectDraft()
      setNewLinearProjectOpen(false)
      setNewLinearProjectName('')
      setNewLinearProjectDescription('')
      setNewLinearProjectContent('')
      setNewLinearProjectLeadId(null)
      setNewLinearProjectMemberIds([])
      setNewLinearProjectLabelIds([])
      setNewLinearProjectPriority(0)
      setNewLinearProjectStartDate('')
      setNewLinearProjectTargetDate('')
      setAppliedLinearProjectSearch('')
      setLinearProjectSearchInput('')
      setLinearProjectsResult((current) => ({
        ...current,
        items: [result.project, ...current.items.filter((item) => item.id !== result.project.id)]
      }))
      setSelectedLinearProjectDetail(result.project)
      openLinearProjectContext(result.project)
      setLinearRefreshNonce((n) => n + 1)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.TaskPage.3ca9b424a3', 'Failed to create project.')
      )
    } finally {
      setNewLinearProjectSubmitting(false)
    }
  }, [
    newLinearProjectContent,
    newLinearProjectDescription,
    newLinearProjectLabelIds,
    newLinearProjectLeadId,
    newLinearProjectMemberIds,
    newLinearProjectName,
    newLinearProjectPriority,
    newLinearProjectStartDate,
    newLinearProjectSubmitting,
    newLinearProjectTargetDate,
    newLinearProjectTargetTeam,
    openLinearProjectContext,
    linearTaskSourceContext,
    settings,
    discardNewLinearProjectDraft,

    setNewLinearProjectLabelIds,
    setNewLinearProjectStartDate,
    setLinearProjectsResult,
    setSelectedLinearProjectDetail,
    setNewLinearProjectPriority,
    setNewLinearProjectOpen,
    setAppliedLinearProjectSearch,
    setLinearProjectSearchInput,
    setNewLinearProjectContent,
    setNewLinearProjectTargetDate,
    setNewLinearProjectLeadId,
    setNewLinearProjectSubmitting,
    setNewLinearProjectName,
    setNewLinearProjectDescription,
    setNewLinearProjectMemberIds,
    setLinearRefreshNonce
  ])

  const handleCreateNewLinearIssue = useCallback(async (): Promise<void> => {
    if (!newLinearIssueTargetTeam) {
      return
    }
    const title = newLinearIssueTitle.trim()
    if (!title || newLinearIssueSubmitting) {
      return
    }
    if (
      selectedLinearProject &&
      newLinearIssueProjectId === selectedLinearProject.id &&
      newLinearIssueTargetTeam.workspaceId !== selectedLinearProject.workspaceId
    ) {
      toast.error(
        translate(
          'auto.components.TaskPage.1e1b2ad8f2',
          'Select a team from the project workspace before filing this issue.'
        )
      )
      return
    }
    setNewLinearIssueSubmitting(true)
    const submitProviderRuntimeContextKey = providerRuntimeContextKey
    try {
      const result = await linearCreateIssue(linearTaskSourceContext ?? settings, {
        teamId: newLinearIssueTargetTeam.id,
        title,
        description: newLinearIssueBody || undefined,
        workspaceId: newLinearIssueTargetTeam.workspaceId,
        stateId: newLinearIssueStateId || undefined,
        priority: newLinearIssuePriority,
        assigneeId: newLinearIssueAssigneeId || undefined,
        projectId: newLinearIssueProjectId || null,
        labelIds: newLinearIssueLabelIds.length > 0 ? newLinearIssueLabelIds : undefined
      })
      if (submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current) {
        return
      }
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
        )
        return
      }
      toast.success(
        translate('auto.components.TaskPage.cb98f0350c', 'Created {{value0}}', {
          value0: result.identifier
        }),
        {
          action: result.url
            ? {
                label: translate('auto.components.TaskPage.9c57663908', 'View'),
                onClick: () => window.open(result.url, '_blank')
              }
            : undefined
        }
      )
      discardNewLinearIssueDraft()
      setNewLinearIssueOpen(false)
      setNewLinearIssueTitle('')
      setNewLinearIssueBody('')
      setNewLinearIssueStateId(null)
      setNewLinearIssueAssigneeId(null)
      setNewLinearIssuePriority(0)
      setNewLinearIssueProjectId(null)
      setNewLinearIssueLabelIds([])
      setLinearRefreshNonce((n) => n + 1)
      useAppStore.getState().recordFeatureInteraction('linear-tasks')

      // Why: auto-select the new issue so the user sees exactly what was filed (mirrors the GitHub create-issue flow).
      void linearGetIssue(
        linearTaskSourceContext ?? settings,
        result.id,
        newLinearIssueTargetTeam.workspaceId
      )
        .then((full) => {
          if (submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current) {
            return
          }
          if (full) {
            setSelectedLinearIssue(full, { allowOutsideList: true })
          }
        })
        .catch(() => {})
    } catch (error) {
      // Why: a stale runtime context already handed the dialog to another provider; its toast would be noise.
      if (submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
        )
      }
    } finally {
      if (submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current) {
        setNewLinearIssueSubmitting(false)
      }
    }
  }, [
    newLinearIssueBody,
    newLinearIssueSubmitting,
    newLinearIssueTargetTeam,
    newLinearIssueTitle,
    newLinearIssueStateId,
    newLinearIssuePriority,
    newLinearIssueAssigneeId,
    newLinearIssueProjectId,
    newLinearIssueLabelIds,
    providerRuntimeContextKey,
    selectedLinearProject,
    setSelectedLinearIssue,
    linearTaskSourceContext,
    settings,
    discardNewLinearIssueDraft,

    setNewLinearIssueTitle,
    setNewLinearIssueStateId,
    providerRuntimeContextKeyRef,
    setNewLinearIssueOpen,
    setNewLinearIssueAssigneeId,
    setNewLinearIssueBody,
    setNewLinearIssueSubmitting,
    setNewLinearIssueLabelIds,
    setNewLinearIssuePriority,
    setNewLinearIssueProjectId,
    setLinearRefreshNonce
  ])

  return { handleCreateNewLinearProject, handleCreateNewLinearIssue }
}
