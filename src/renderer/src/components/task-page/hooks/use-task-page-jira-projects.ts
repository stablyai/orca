import { useEffect, useState } from 'react'

import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { JiraProject } from '../../../../../shared/jira-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { jiraListProjects } from '@/runtime/runtime-jira-client'

export function useTaskPageJiraProjects({
  taskResumeApplied,
  taskSource,
  jiraConnected,
  jiraTaskSourceContext,
  settings,
  selectedJiraSiteId
}: {
  taskResumeApplied: boolean
  taskSource: TaskProvider
  jiraConnected: boolean
  jiraTaskSourceContext: TaskSourceContext | null
  settings: GlobalSettings | null
  selectedJiraSiteId: string | null
}) {
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
      .catch((error) => {
        if (!cancelled) {
          console.warn('[TaskPage] Failed to fetch Jira projects', error)
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

  return {
    availableJiraProjects,
    setAvailableJiraProjects,
    jiraProjectsLoading,
    setJiraProjectsLoading
  }
}
