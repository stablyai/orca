import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import type {
  KanbanConnectionStatus,
  KanbanTaskDetails,
  KanbanTaskFilter,
  KanbanTaskListResult
} from '../../../../../shared/kanban-types'
import type { TaskProvider } from '../../../../../shared/task-providers'

export type KanbanListLoadError = { kind: 'network'; message: string } | { kind: 'auth' }

export type KanbanTaskListLoadState =
  | { kind: 'disconnected' }
  | { kind: 'auth' }
  | { kind: 'loading' }
  | { kind: 'stale'; message: string }
  | { kind: 'network-empty'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready' }

export type KanbanTaskDetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; detail: KanbanTaskDetails }
  | { kind: 'not-found' }
  | { kind: 'error' }

const AUTH_FAILURE_PATTERN = /authentication failed|access is forbidden|reconnect your token/i

export function classifyKanbanListFailure(error: unknown): KanbanListLoadError {
  const message = error instanceof Error ? error.message : 'Failed to load Kanban tasks. Try again.'
  if (AUTH_FAILURE_PATTERN.test(message)) {
    return { kind: 'auth' }
  }
  return { kind: 'network', message }
}

// Why: a network failure must keep the previously loaded list visible with a
// retry, while an auth failure replaces the list actions with a reconnect.
export function deriveKanbanTaskListLoadState({
  status,
  loading,
  error,
  visibleTaskCount
}: {
  status: KanbanConnectionStatus
  loading: boolean
  error: KanbanListLoadError | null
  visibleTaskCount: number
}): KanbanTaskListLoadState {
  if (!status.connected) {
    return { kind: 'disconnected' }
  }
  if (error?.kind === 'auth') {
    return { kind: 'auth' }
  }
  if (error?.kind === 'network') {
    return visibleTaskCount > 0
      ? { kind: 'stale', message: error.message }
      : { kind: 'network-empty', message: error.message }
  }
  if (loading && visibleTaskCount === 0) {
    return { kind: 'loading' }
  }
  if (visibleTaskCount === 0) {
    return { kind: 'empty' }
  }
  return { kind: 'ready' }
}

export function deriveKanbanTaskDetailState({
  selectedTaskId,
  detail,
  detailLoading,
  detailError
}: {
  selectedTaskId: string | null
  detail: KanbanTaskDetails | null
  detailLoading: boolean
  detailError: boolean
}): KanbanTaskDetailState {
  if (!selectedTaskId) {
    return { kind: 'idle' }
  }
  if (detailError) {
    return { kind: 'error' }
  }
  if (detailLoading) {
    return { kind: 'loading' }
  }
  if (detail) {
    return { kind: 'ready', detail }
  }
  return { kind: 'not-found' }
}

export function useTaskPageKanbanFetch({
  taskSource,
  kanbanStatus,
  setKanbanStatus,
  kanbanFilter,
  kanbanRefreshNonce,
  setKanbanRefreshNonce,
  setKanbanResult,
  setKanbanLoading,
  setKanbanLoadError,
  kanbanSelectedTaskId,
  setKanbanDetail,
  setKanbanDetailLoading,
  setKanbanDetailError
}: {
  taskSource: TaskProvider
  kanbanStatus: KanbanConnectionStatus
  setKanbanStatus: Dispatch<SetStateAction<KanbanConnectionStatus>>
  kanbanFilter: KanbanTaskFilter
  kanbanRefreshNonce: number
  setKanbanRefreshNonce: Dispatch<SetStateAction<number>>
  setKanbanResult: Dispatch<SetStateAction<KanbanTaskListResult | null>>
  setKanbanLoading: Dispatch<SetStateAction<boolean>>
  setKanbanLoadError: Dispatch<SetStateAction<KanbanListLoadError | null>>
  kanbanSelectedTaskId: string | null
  setKanbanDetail: Dispatch<SetStateAction<KanbanTaskDetails | null>>
  setKanbanDetailLoading: Dispatch<SetStateAction<boolean>>
  setKanbanDetailError: Dispatch<SetStateAction<boolean>>
}): { refreshKanban: () => void } {
  useEffect(() => {
    if (taskSource !== 'kanban') {
      return
    }
    let cancelled = false
    void window.api.kanban
      .status()
      .then((next) => {
        if (!cancelled) {
          setKanbanStatus(next)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [kanbanRefreshNonce, setKanbanStatus, taskSource])

  useEffect(() => {
    if (taskSource !== 'kanban') {
      return
    }
    if (!kanbanStatus.connected) {
      setKanbanLoading(false)
      return
    }
    let cancelled = false
    setKanbanLoading(true)
    setKanbanLoadError(null)
    void window.api.kanban
      .listTasks({ filter: kanbanFilter })
      .then((result) => {
        if (cancelled) {
          return
        }
        setKanbanResult(result)
        setKanbanLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        const failure = classifyKanbanListFailure(error)
        setKanbanLoadError(failure)
        setKanbanLoading(false)
        if (failure.kind === 'auth') {
          setKanbanStatus({ connected: false, reason: 'invalid' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    kanbanFilter,
    kanbanRefreshNonce,
    kanbanStatus.connected,
    setKanbanLoadError,
    setKanbanLoading,
    setKanbanResult,
    setKanbanStatus,
    taskSource
  ])

  useEffect(() => {
    if (taskSource !== 'kanban' || !kanbanSelectedTaskId) {
      setKanbanDetail(null)
      setKanbanDetailError(false)
      return
    }
    let cancelled = false
    setKanbanDetailLoading(true)
    setKanbanDetailError(false)
    void window.api.kanban
      .getTask({ id: kanbanSelectedTaskId })
      .then((detail) => {
        if (cancelled) {
          return
        }
        setKanbanDetail(detail)
        setKanbanDetailLoading(false)
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setKanbanDetail(null)
        setKanbanDetailError(true)
        setKanbanDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    kanbanSelectedTaskId,
    setKanbanDetail,
    setKanbanDetailError,
    setKanbanDetailLoading,
    taskSource
  ])

  const refreshKanban = useCallback(() => {
    setKanbanRefreshNonce((n) => n + 1)
  }, [setKanbanRefreshNonce])

  return { refreshKanban }
}
