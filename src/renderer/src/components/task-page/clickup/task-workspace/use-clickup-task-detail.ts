import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getCommentBodySubmitState } from '@/lib/source-control/review/comments/comment-body-submit-state'
import {
  taskProviderErrorMessage,
  taskProviderErrorText
} from '@/lib/work-items/task-provider-error-copy'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import {
  clickupCacheKey,
  clickupTaskCacheKey,
  getClickUpReadScope
} from '@/store/slices/clickup/clickup-read-coordination'
import type {
  ClickUpStatusOption,
  ClickUpTask
} from '../../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'
import { withBusyFlag } from '../clickup-busy-flag'

type LoadState = { loading: boolean; error: string | null }

function errorText(error: unknown): string {
  return taskProviderErrorText(error instanceof Error ? error.message : String(error))
}

/** The open ClickUp task with its freshest cached copy, thread, status options and write actions. */
export function useClickUpTaskDetail(task: ClickUpTask, sourceContext: TaskSourceContext) {
  const fetchClickUpTask = useAppStore((s) => s.fetchClickUpTask)
  const listClickUpTaskComments = useAppStore((s) => s.listClickUpTaskComments)
  const listClickUpStatusOptions = useAppStore((s) => s.listClickUpStatusOptions)
  const updateClickUpTaskStatus = useAppStore((s) => s.updateClickUpTaskStatus)
  const addClickUpTaskComment = useAppStore((s) => s.addClickUpTaskComment)
  const cachedTask = useAppStore(
    (s) => s.clickupTaskCache[clickupTaskCacheKey(s, sourceContext, task.id)]?.data ?? null
  )
  const comments = useAppStore(
    (s) =>
      s.clickupCommentCache[
        clickupCacheKey(getClickUpReadScope(s, sourceContext), `comments::${task.id}`)
      ]?.data ?? null
  )
  const listId = (cachedTask ?? task).list.id
  const statusOptions = useAppStore(
    (s) =>
      s.clickupStatusOptionsCache[
        clickupCacheKey(getClickUpReadScope(s, sourceContext), `statuses::${listId}`)
      ]?.data ?? null
  )
  const [taskState, setTaskState] = useState<LoadState>({ loading: true, error: null })
  const [commentsState, setCommentsState] = useState<LoadState>({ loading: true, error: null })
  const [statusesState, setStatusesState] = useState<LoadState>({ loading: true, error: null })
  const [pendingStatus, setPendingStatus] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [reloadNonce, setReloadNonce] = useState({ comments: 0, statuses: 0 })

  useEffect(() => {
    let cancelled = false
    void fetchClickUpTask(task.id, { sourceContext })
      .then(() => !cancelled && setTaskState({ loading: false, error: null }))
      .catch(
        (error: unknown) => !cancelled && setTaskState({ loading: false, error: errorText(error) })
      )
    return () => {
      cancelled = true
    }
  }, [fetchClickUpTask, sourceContext, task.id])

  useEffect(() => {
    let cancelled = false
    setCommentsState({ loading: true, error: null })
    void listClickUpTaskComments(task.id, { sourceContext, force: reloadNonce.comments > 0 })
      .then(() => !cancelled && setCommentsState({ loading: false, error: null }))
      .catch(
        (error: unknown) =>
          !cancelled && setCommentsState({ loading: false, error: errorText(error) })
      )
    return () => {
      cancelled = true
    }
  }, [listClickUpTaskComments, reloadNonce.comments, sourceContext, task.id])

  useEffect(() => {
    let cancelled = false
    setStatusesState({ loading: true, error: null })
    void listClickUpStatusOptions(listId, { sourceContext, force: reloadNonce.statuses > 0 })
      .then(() => !cancelled && setStatusesState({ loading: false, error: null }))
      .catch(
        (error: unknown) =>
          !cancelled && setStatusesState({ loading: false, error: errorText(error) })
      )
    return () => {
      cancelled = true
    }
  }, [listClickUpStatusOptions, listId, reloadNonce.statuses, sourceContext])

  const displayed = cachedTask ?? task

  const changeStatus = useCallback(
    async (status: ClickUpStatusOption): Promise<void> => {
      if (pendingStatus || status.name === displayed.status.name) {
        return
      }
      const result = await withBusyFlag(setPendingStatus, () =>
        updateClickUpTaskStatus(displayed, status, { sourceContext })
      )
      if (!result.ok) {
        toast.error(taskProviderErrorMessage(result))
      }
    },
    [displayed, pendingStatus, sourceContext, updateClickUpTaskStatus]
  )

  const submitComment = useCallback(async (): Promise<void> => {
    if (commentSubmitting) {
      return
    }
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate('taskProviders.clickup.commentTooLarge', 'Comment is too large to submit safely.')
      )
      return
    }
    try {
      const result = await withBusyFlag(setCommentSubmitting, () =>
        addClickUpTaskComment(task.id, bodyState.body, { sourceContext })
      )
      if (result.ok) {
        setCommentDraft('')
      } else {
        toast.error(taskProviderErrorMessage(result))
      }
    } catch (error) {
      toast.error(errorText(error))
    }
  }, [addClickUpTaskComment, commentDraft, commentSubmitting, sourceContext, task.id])

  return {
    displayed,
    taskLoading: taskState.loading,
    taskError: taskState.error,
    comments: comments ?? [],
    commentsLoading: commentsState.loading && comments === null,
    commentsError: commentsState.error,
    retryComments: () =>
      setReloadNonce((current) => ({ ...current, comments: current.comments + 1 })),
    statusOptions: statusOptions ?? [],
    statusesLoading: statusesState.loading && statusOptions === null,
    statusesError: statusesState.error,
    retryStatuses: () =>
      setReloadNonce((current) => ({ ...current, statuses: current.statuses + 1 })),
    pendingStatus,
    changeStatus,
    commentDraft,
    setCommentDraft,
    commentSubmitting,
    submitComment
  }
}
