import type { TaskPageResumeRestorationModel } from './use-task-page-resume-restoration'
import { useState, useEffect } from 'react'
import type { LinearTeam } from '../../../shared/linear/workspace-types'
import type { JiraProject } from '../../../shared/jira-types'
import { jiraListProjects } from '@/runtime/runtime-jira-client'
export function useTaskPageProviderMetadata(model: TaskPageResumeRestorationModel) {
  const {
    settings,
    getCachedLinearTeams,
    listLinearTeams,
    linearConnected,
    jiraConnected,
    selectedLinearWorkspaceId,
    selectedJiraSiteId,
    taskSource,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    taskResumeApplied
  } = model
  // Why: fetch the full Linear team list so the selector shows all teams, not just those with issues in the fetch window.
  const [availableTeams, setAvailableTeams] = useState<LinearTeam[]>([])
  const [linearTeamRefreshNonce, setLinearTeamRefreshNonce] = useState(0)
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || !linearConnected) {
      setAvailableTeams([])
      return
    }
    let cancelled = false
    const cachedTeams = getCachedLinearTeams(selectedLinearWorkspaceId, {
      sourceContext: linearTaskSourceContext
    })
    // Why: on a workspace switch, drop the prior workspace's teams during the pending fetch but seed from the workspace-scoped cache.
    setAvailableTeams(cachedTeams ?? [])
    void listLinearTeams(selectedLinearWorkspaceId, {
      sourceContext: linearTaskSourceContext
    })
      .then((teams) => {
        if (!cancelled) {
          setAvailableTeams(teams)
        }
      })
      .catch(() => {
        if (!cancelled) {
          console.warn('[TaskPage] Failed to fetch Linear teams')
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskSource,
    linearConnected,
    selectedLinearWorkspaceId,
    linearTeamRefreshNonce,
    taskResumeApplied,
    getCachedLinearTeams,
    listLinearTeams,
    linearTaskSourceContext
  ])
  const [availableJiraProjects, setAvailableJiraProjects] = useState<JiraProject[]>([])
  const [jiraProjectsLoading, setJiraProjectsLoading] = useState(false)
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'jira' || !jiraConnected) {
      setAvailableJiraProjects([])
      setJiraProjectsLoading(false)
      return
    }
    let cancelled = false
    setAvailableJiraProjects([])
    setJiraProjectsLoading(true)
    void jiraListProjects(jiraTaskSourceContext ?? settings, selectedJiraSiteId)
      .then((projects) => {
        if (!cancelled) {
          setAvailableJiraProjects(projects)
        }
      })
      .catch(() => {
        if (!cancelled) {
          console.warn('[TaskPage] Failed to fetch Jira projects')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setJiraProjectsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    settings,
    taskSource,
    jiraConnected,
    selectedJiraSiteId,
    taskResumeApplied,
    jiraTaskSourceContext
  ])

  // Why: fetch GitLab Issues and MRs separately so errors stay isolated per tab (mirrors GitHub's split endpoints).
  const nextModel = model as typeof model & {
    availableTeams: typeof availableTeams
    setAvailableTeams: typeof setAvailableTeams
    linearTeamRefreshNonce: typeof linearTeamRefreshNonce
    setLinearTeamRefreshNonce: typeof setLinearTeamRefreshNonce
    availableJiraProjects: typeof availableJiraProjects
    setAvailableJiraProjects: typeof setAvailableJiraProjects
    jiraProjectsLoading: typeof jiraProjectsLoading
    setJiraProjectsLoading: typeof setJiraProjectsLoading
  }
  nextModel.availableTeams = availableTeams
  nextModel.setAvailableTeams = setAvailableTeams
  nextModel.linearTeamRefreshNonce = linearTeamRefreshNonce
  nextModel.setLinearTeamRefreshNonce = setLinearTeamRefreshNonce
  nextModel.availableJiraProjects = availableJiraProjects
  nextModel.setAvailableJiraProjects = setAvailableJiraProjects
  nextModel.jiraProjectsLoading = jiraProjectsLoading
  nextModel.setJiraProjectsLoading = setJiraProjectsLoading
  return nextModel
}
export type TaskPageProviderMetadataModel = ReturnType<typeof useTaskPageProviderMetadata>
