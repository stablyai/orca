/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Asana task hydration, comments, completion, and user options are loaded from provider IPC for the selected task. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clipboard, ExternalLink, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  asanaAddTaskComment,
  asanaGetTask,
  asanaListAssignableUsers,
  asanaTaskComments,
  asanaUpdateTask
} from '@/runtime/runtime-asana-client'
import { translate } from '@/i18n/i18n'
import type { AsanaComment, AsanaTask, AsanaUser } from '../../../shared/types'
import {
  buildAsanaBranchName,
  buildAsanaPrompt,
  copyTextToClipboard
} from './asana-task-drawer-format'

// Why: the Asana drawer's data loading, optimistic mutation, and comment state
// live here so the component file stays a focused view of that state.
export function useAsanaTaskDrawer(task: AsanaTask | null) {
  const settings = useAppStore((s) => s.settings)
  const patchAsanaTask = useAppStore((s) => s.patchAsanaTask)
  const [fullTask, setFullTask] = useState<AsanaTask | null>(null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [comments, setComments] = useState<AsanaComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [users, setUsers] = useState<AsanaUser[]>([])
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<AsanaComment[]>([])

  const displayed = fullTask ?? task
  const workspaceId = displayed?.workspaceId ?? undefined

  const loadComments = useCallback(
    async (targetTask: AsanaTask, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await asanaTaskComments(settings, targetTask.gid, targetTask.workspaceId)
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.gid))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.gid))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [settings]
  )

  useEffect(() => {
    if (!task) {
      setFullTask(null)
      setTaskLoading(false)
      setComments([])
      setCommentsError(null)
      setUsers([])
      setCommentDraft('')
      optimisticCommentsRef.current = []
      return
    }

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    optimisticCommentsRef.current = []
    setFullTask(task)
    setTitleDraft(task.title)
    setNotesDraft(task.description ?? '')
    setComments([])
    setCommentsError(null)
    setTaskLoading(true)

    void asanaGetTask(settings, task.gid, task.workspaceId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullTask(result)
          setTitleDraft(result.title)
          setNotesDraft(result.description ?? '')
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setTaskLoading(false)
        }
      })

    void asanaListAssignableUsers(settings, task.workspaceId)
      .then((nextUsers) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setUsers(nextUsers)
      })
      .catch(() => {})

    void loadComments(task, requestId)
  }, [task, loadComments, settings])

  const refreshTask = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    // Why: a newer task selection bumps requestIdRef; bail on repaint if this
    // refresh resolved after the user moved on, to avoid stale data.
    const activeRequestId = requestIdRef.current
    try {
      const latest = await asanaGetTask(settings, displayed.gid, displayed.workspaceId)
      if (latest && activeRequestId === requestIdRef.current) {
        setFullTask(latest)
        patchAsanaTask(latest.gid, latest)
      }
    } catch {
      // Keep the visible task snapshot if refresh fails.
    }
  }, [displayed, patchAsanaTask, settings])

  const mutateTask = useCallback(
    async (
      field: string,
      updates: Parameters<typeof asanaUpdateTask>[2],
      optimistic?: Partial<AsanaTask>
    ): Promise<void> => {
      if (!displayed || pendingField) {
        return
      }
      // Why: guard the rollback repaint so a stale mutation can't overwrite a
      // task the user selected while the request was in flight.
      const activeRequestId = requestIdRef.current
      setPendingField(field)
      const previous = displayed
      try {
        if (optimistic) {
          setFullTask({ ...displayed, ...optimistic })
          patchAsanaTask(displayed.gid, optimistic)
        }
        const result = await asanaUpdateTask(settings, displayed.gid, updates, workspaceId)
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshTask()
      } catch (error) {
        if (activeRequestId === requestIdRef.current) {
          setFullTask(previous)
        }
        patchAsanaTask(previous.gid, previous)
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.AsanaIssueWorkspace.3c481bf8d7',
                'Failed to update Asana task.'
              )
        )
      } finally {
        setPendingField(null)
      }
    },
    [displayed, patchAsanaTask, pendingField, refreshTask, settings, workspaceId]
  )

  const handleSaveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateTask('title', { title }, { title })
  }, [displayed, mutateTask, titleDraft])

  const handleSaveNotes = useCallback(() => {
    if (!displayed) {
      return
    }
    const notes = notesDraft
    if (notes === (displayed.description ?? '')) {
      return
    }
    void mutateTask('notes', { notes }, { description: notes })
  }, [displayed, mutateTask, notesDraft])

  const handleToggleCompleted = useCallback(() => {
    if (!displayed) {
      return
    }
    const completed = !displayed.completed
    void mutateTask('completed', { completed }, { completed })
  }, [displayed, mutateTask])

  const handleSetApproval = useCallback(
    (approvalStatus: 'approved' | 'rejected' | 'changes_requested') => {
      // Why: Asana keeps approval_status and completed in sync — any decision
      // other than pending completes the task.
      void mutateTask('approval', { approvalStatus }, { approvalStatus, completed: true })
    },
    [mutateTask]
  )

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!displayed || commentSubmitting) {
      return
    }
    const text = commentDraft.trim()
    if (!text) {
      return
    }
    setCommentSubmitting(true)
    try {
      const result = await asanaAddTaskComment(settings, displayed.gid, text, displayed.workspaceId)
      if (!result.ok) {
        throw new Error(result.error)
      }
      const comment: AsanaComment = {
        gid: result.id || createBrowserUuid(),
        text,
        createdAt: new Date().toISOString(),
        user: { gid: 'local', name: 'You' }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.AsanaIssueWorkspace.c76cc7f483', 'Failed to add comment.')
      )
    } finally {
      setCommentSubmitting(false)
    }
  }, [commentDraft, commentSubmitting, displayed, settings])

  const actionItems = useMemo(() => {
    if (!displayed) {
      return []
    }
    return [
      {
        label: translate('auto.components.AsanaIssueWorkspace.9bd2fa9f44', 'Open in Asana'),
        icon: ExternalLink,
        action: () => window.api.shell.openUrl(displayed.url)
      },
      {
        label: translate('auto.components.AsanaIssueWorkspace.45f81355bc', 'Copy URL'),
        icon: Clipboard,
        action: () => void copyTextToClipboard(displayed.url, 'URL')
      },
      {
        label: translate(
          'auto.components.AsanaIssueWorkspace.47bdb1b01a',
          'Copy suggested branch name'
        ),
        icon: GitBranch,
        action: () => void copyTextToClipboard(buildAsanaBranchName(displayed), 'Branch name')
      },
      {
        label: translate('auto.components.AsanaIssueWorkspace.fc73c32b3c', 'Copy prompt'),
        icon: Clipboard,
        action: () => void copyTextToClipboard(buildAsanaPrompt(displayed), 'Prompt')
      }
    ]
  }, [displayed])

  const projectLabel = displayed?.projects[0]?.name ?? displayed?.workspaceName ?? 'Asana'

  return {
    displayed,
    projectLabel,
    taskLoading,
    pendingField,
    users,
    comments,
    commentsLoading,
    commentsError,
    titleDraft,
    setTitleDraft,
    notesDraft,
    setNotesDraft,
    commentDraft,
    setCommentDraft,
    commentSubmitting,
    requestIdRef,
    loadComments,
    mutateTask,
    handleSaveTitle,
    handleSaveNotes,
    handleToggleCompleted,
    handleSetApproval,
    handleSubmitComment,
    actionItems
  }
}
