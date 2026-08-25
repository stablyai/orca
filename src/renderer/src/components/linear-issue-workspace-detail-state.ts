import { useCallback, useEffect, useRef, useState } from 'react'

import { createBrowserUuid } from '@/lib/browser-uuid'
import { useMountedRef } from '@/hooks/useMountedRef'
import { linearGetIssue, linearIssueComments } from '@/runtime/runtime-linear-client'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import {
  initLinearIssueEditState,
  type LinearEditState,
  type LinearLocalComment
} from '@/components/LinearItemDrawer'
import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearProjectSummary } from '../../../shared/linear/project-types'

const EDITED_LINEAR_ISSUE_FIELDS = [
  'state',
  'title',
  'description',
  'priority',
  'assignee',
  'estimate',
  'labelIds',
  'labels'
] as const

export function mergeLinearIssueHydration(
  fetched: LinearIssue,
  current: LinearIssue | null,
  hasEdited: boolean
): LinearIssue {
  if (!hasEdited || !current) {
    return fetched
  }
  const merged = { ...fetched }
  for (const field of EDITED_LINEAR_ISSUE_FIELDS) {
    Object.assign(merged, { [field]: current[field] })
  }
  return merged
}

export function mergeLinearIssueComments(
  fetched: LinearComment[],
  optimistic: LinearComment[]
): LinearComment[] {
  if (optimistic.length === 0) {
    return fetched
  }
  const fetchedIds = new Set(fetched.map((comment) => comment.id))
  return [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
}

export type LinearIssueWorkspaceDetailState = {
  displayed: LinearIssue
  issueLoading: boolean
  comments: LinearComment[]
  commentsLoading: boolean
  commentsError: string | null
  editState: LinearEditState
  handleEditStateChange: (patch: Partial<LinearEditState>) => void
  handleIssueTextChange: (patch: Partial<Pick<LinearIssue, 'title' | 'description'>>) => void
  handleCommentAdded: (comment: LinearLocalComment) => void
  handleProjectChanged: (project: LinearProjectSummary) => void
  retryComments: () => Promise<void>
}

export function useLinearIssueWorkspaceDetail({
  issue,
  providerSettings,
  requestKey
}: {
  issue: LinearIssue
  providerSettings: RuntimeLinearSettings
  requestKey: string
}): LinearIssueWorkspaceDetailState {
  const [fullIssue, setFullIssue] = useState<LinearIssue>(issue)
  const [issueLoading, setIssueLoading] = useState(true)
  const [comments, setComments] = useState<LinearComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(true)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [editState, setEditState] = useState<LinearEditState>(() => initLinearIssueEditState(issue))
  const initialRequestRef = useRef({ issue, providerSettings })
  const hasEditedRef = useRef(false)
  const optimisticCommentsRef = useRef<LinearComment[]>([])
  const commentsRequestIdRef = useRef(0)
  const hydrationRequestIdRef = useRef(0)
  const mountedRef = useMountedRef()
  const handleEditStateChange = useCallback((patch: Partial<LinearEditState>) => {
    hasEditedRef.current = true
    setFullIssue((current) => ({ ...current, ...patch }))
    setEditState((current) => ({ ...current, ...patch }))
  }, [])

  const handleIssueTextChange = useCallback(
    (patch: Partial<Pick<LinearIssue, 'title' | 'description'>>) => {
      hasEditedRef.current = true
      setFullIssue((current) => ({ ...current, ...patch }))
    },
    []
  )

  const handleProjectChanged = useCallback((project: LinearProjectSummary) => {
    setFullIssue((prev) => (prev ? { ...prev, project } : prev))
  }, [])

  const handleCommentAdded = useCallback((comment: LinearLocalComment) => {
    const added: LinearComment = {
      id: comment.id || createBrowserUuid(),
      body: comment.body,
      createdAt: comment.createdAt,
      user: { displayName: 'You' }
    }
    optimisticCommentsRef.current.push(added)
    setComments((current) => [...current, added])
  }, [])

  const loadComments = useCallback(
    (targetIssue: LinearIssue, targetProviderSettings: RuntimeLinearSettings): Promise<void> => {
      const requestId = ++commentsRequestIdRef.current
      setCommentsLoading(true)
      setCommentsError(null)
      return linearIssueComments(targetProviderSettings, targetIssue.id, targetIssue.workspaceId)
        .then((fetched) => {
          if (mountedRef.current && requestId === commentsRequestIdRef.current) {
            setComments(mergeLinearIssueComments(fetched, optimisticCommentsRef.current))
          }
        })
        .catch((error) => {
          if (mountedRef.current && requestId === commentsRequestIdRef.current) {
            setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
          }
        })
        .finally(() => {
          if (mountedRef.current && requestId === commentsRequestIdRef.current) {
            setCommentsLoading(false)
          }
        })
    },
    [mountedRef]
  )

  const retryComments = useCallback(
    () => loadComments(issue, providerSettings),
    [issue, loadComments, providerSettings]
  )

  useEffect(() => {
    const requestId = ++hydrationRequestIdRef.current
    setIssueLoading(true)
    const initialRequest = initialRequestRef.current
    void linearGetIssue(
      initialRequest.providerSettings,
      initialRequest.issue.id,
      initialRequest.issue.workspaceId
    )
      .then((fetched) => {
        if (!mountedRef.current || requestId !== hydrationRequestIdRef.current || !fetched) {
          return
        }
        setFullIssue((current) => mergeLinearIssueHydration(fetched, current, hasEditedRef.current))
        if (!hasEditedRef.current) {
          setEditState(initLinearIssueEditState(fetched))
        }
      })
      .catch(() => {
        // The selected list issue remains usable when provider detail is unavailable.
      })
      .finally(() => {
        if (mountedRef.current && requestId === hydrationRequestIdRef.current) {
          setIssueLoading(false)
        }
      })
    void loadComments(initialRequest.issue, initialRequest.providerSettings)
    return () => {
      hydrationRequestIdRef.current += 1
      commentsRequestIdRef.current += 1
    }
  }, [loadComments, mountedRef, requestKey])

  return {
    displayed: fullIssue,
    issueLoading,
    comments,
    commentsLoading,
    commentsError,
    editState,
    handleEditStateChange,
    handleIssueTextChange,
    handleCommentAdded,
    handleProjectChanged,
    retryComments
  }
}
