import type { TaskPageBusinessmapCreationStateModel } from './use-task-page-businessmap-creation-state'
import { useEffect } from 'react'

export function useTaskPageBusinessmapCreationMetadata(
  model: TaskPageBusinessmapCreationStateModel
) {
  const {
    settings,
    businessmapConnected,
    businessmapTaskSourceContext,
    taskSource,
    taskResumeApplied,
    newBusinessmapCardOpen,
    setAvailableBusinessmapBoards,
    setBusinessmapBoardsLoading,
    listBusinessmapBoards
  } = model
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'businessmap' || !businessmapConnected) {
      setAvailableBusinessmapBoards([])
      setBusinessmapBoardsLoading(false)
      return
    }
    let cancelled = false
    setAvailableBusinessmapBoards([])
    setBusinessmapBoardsLoading(true)
    void listBusinessmapBoards({
      sourceContext: businessmapTaskSourceContext ?? undefined
    })
      .then((boards) => {
        if (!cancelled) {
          setAvailableBusinessmapBoards(boards)
        }
      })
      .catch(() => {
        if (!cancelled) {
          console.warn('[TaskPage] Failed to fetch Businessmap boards')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusinessmapBoardsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings,
    taskSource,
    businessmapConnected,
    taskResumeApplied,
    businessmapTaskSourceContext,
    newBusinessmapCardOpen
  ])
  return model
}

export type TaskPageBusinessmapCreationMetadataModel = ReturnType<
  typeof useTaskPageBusinessmapCreationMetadata
>
