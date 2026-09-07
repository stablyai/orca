import type { TaskPageGitHubIssueCreationModel } from './use-task-page-github-issue-creation'
import { useCallback } from 'react'
import { linearCreateProject } from '@/runtime/runtime-linear-project-client'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
export function useTaskPageLinearProjectCreation(model: TaskPageGitHubIssueCreationModel) {
  const {
    settings,
    linearTaskSourceContext,
    setLinearRefreshNonce,
    setLinearProjectSearchInput,
    setAppliedLinearProjectSearch,
    setLinearProjectsResult,
    setSelectedLinearProjectDetail,
    openLinearProjectContext,
    setNewLinearProjectOpen,
    newLinearProjectName,
    setNewLinearProjectName,
    newLinearProjectDescription,
    setNewLinearProjectDescription,
    newLinearProjectContent,
    setNewLinearProjectContent,
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
    discardNewLinearProjectDraft
  } = model
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
    setNewLinearProjectMemberIds,
    setNewLinearProjectOpen,
    setNewLinearProjectTargetDate,
    setNewLinearProjectPriority,
    setNewLinearProjectDescription,
    setNewLinearProjectContent,
    setNewLinearProjectStartDate,
    setLinearProjectsResult,
    setLinearProjectSearchInput,
    setSelectedLinearProjectDetail,
    setLinearRefreshNonce,
    setNewLinearProjectLabelIds,
    setNewLinearProjectLeadId,
    setNewLinearProjectName,
    setNewLinearProjectSubmitting,
    setAppliedLinearProjectSearch
  ])
  const nextModel = model as typeof model & {
    handleCreateNewLinearProject: typeof handleCreateNewLinearProject
  }
  nextModel.handleCreateNewLinearProject = handleCreateNewLinearProject
  return nextModel
}
export type TaskPageLinearProjectCreationModel = ReturnType<typeof useTaskPageLinearProjectCreation>
