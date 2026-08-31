import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { resolveVisibleTaskProvider, type TaskProvider } from '../../../../../shared/task-providers'

export function useTaskPageSourceSync({
  pageData,
  preferredTaskSource,
  taskSource,
  setTaskSource,
  visibleTaskProviders,
  settings
}: {
  pageData: { taskSource?: TaskProvider }
  preferredTaskSource: TaskProvider
  taskSource: TaskProvider
  setTaskSource: Dispatch<SetStateAction<TaskProvider>>
  visibleTaskProviders: TaskProvider[]
  settings: GlobalSettings | null
}) {
  const taskSourceManuallyChangedRef = useRef(false)
  const lastPageTaskSourceRef = useRef(pageData.taskSource)
  const taskResumeAppliedRef = useRef(false)
  const githubSearchPersistReadyRef = useRef(false)
  const linearSearchPersistReadyRef = useRef(false)
  const linearViewPersistReadyRef = useRef(false)
  const jiraSearchPersistReadyRef = useRef(false)
  const [taskResumeApplied, setTaskResumeApplied] = useState(false)

  // Why: useState only inits once, so sync taskSource from the store when a sidebar source-icon click changes pageData.taskSource.
  useEffect(() => {
    const pageTaskSourceChanged = lastPageTaskSourceRef.current !== pageData.taskSource
    lastPageTaskSourceRef.current = pageData.taskSource
    if (pageData.taskSource) {
      if (pageTaskSourceChanged) {
        taskSourceManuallyChangedRef.current = false
      } else if (taskSourceManuallyChangedRef.current) {
        return
      }
      setTaskSource(resolveVisibleTaskProvider(pageData.taskSource, visibleTaskProviders))
    }
  }, [pageData.taskSource, visibleTaskProviders, setTaskSource])

  useEffect(() => {
    if (taskSourceManuallyChangedRef.current) {
      return
    }
    // Why: GitLab/Linear availability hydrates after mount; restore the saved default once its provider check proves it can be shown.
    if (visibleTaskProviders.includes(preferredTaskSource) && taskSource !== preferredTaskSource) {
      setTaskSource(preferredTaskSource)
    }
  }, [preferredTaskSource, taskSource, visibleTaskProviders, setTaskSource])

  useEffect(() => {
    if (!visibleTaskProviders.includes(taskSource)) {
      setTaskSource(resolveVisibleTaskProvider(settings?.defaultTaskSource, visibleTaskProviders))
    }
  }, [settings?.defaultTaskSource, taskSource, visibleTaskProviders, setTaskSource])

  return {
    taskSourceManuallyChangedRef,
    lastPageTaskSourceRef,
    taskResumeAppliedRef,
    githubSearchPersistReadyRef,
    linearSearchPersistReadyRef,
    linearViewPersistReadyRef,
    jiraSearchPersistReadyRef,
    taskResumeApplied,
    setTaskResumeApplied
  }
}
