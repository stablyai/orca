import type { TaskPageMantisBTListStateModel } from './use-task-page-mantisbt-list-state'
import { useEffect, useState } from 'react'
import type { MantisBTProject } from '../../../shared/mantisbt-types'

export type TaskPageMantisBTProjectListModel = TaskPageMantisBTListStateModel & {
  mantisBTProjects: MantisBTProject[]
  mantisBTProjectsLoading: boolean
}

export function useTaskPageMantisBTProjectList(
  model: TaskPageMantisBTListStateModel
): TaskPageMantisBTProjectListModel {
  const {
    taskResumeApplied,
    taskSource,
    mantisBTConnected,
    selectedMantisBTSiteId,
    mantisBTTaskSourceContext,
    listMantisBTProjects
  } = model
  const [mantisBTProjects, setMantisBTProjects] = useState<MantisBTProject[]>([])
  const [mantisBTProjectsLoading, setMantisBTProjectsLoading] = useState(false)

  // Why: the project dropdown lists the current site scope's projects — refetch
  // whenever the connection or selected site changes, mirroring the site list's
  // own scope (mantisBTStatus.sites) rather than a separate, drift-prone source.
  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'mantisBT' || !mantisBTConnected) {
      setMantisBTProjects([])
      return
    }
    let cancelled = false
    setMantisBTProjectsLoading(true)
    void listMantisBTProjects({ sourceContext: mantisBTTaskSourceContext })
      .then((projects) => {
        if (!cancelled) {
          setMantisBTProjects(projects)
        }
      })
      .catch((err) => {
        console.warn('[mantisbt] listMantisBTProjects failed:', err)
      })
      .finally(() => {
        if (!cancelled) {
          setMantisBTProjectsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    taskResumeApplied,
    taskSource,
    mantisBTConnected,
    selectedMantisBTSiteId,
    mantisBTTaskSourceContext,
    listMantisBTProjects
  ])

  return {
    ...model,
    mantisBTProjects,
    mantisBTProjectsLoading
  }
}
