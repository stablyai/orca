import { useCallback, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { GitLabAssignableUser, GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
import type { JobTraceState } from '../gitlab-item-dialog-parts'

export function useGitLabItemDialogState(itemId: string | null, detailsOwner: string | null) {
  const [details, setDetails] = useState<GitLabWorkItemDetails | null>(null)
  const [shownOwner, setShownOwner] = useState(detailsOwner)
  if (shownOwner !== detailsOwner) {
    // Why: drop before paint so a switched target never shows, or edits, the previous one's details (reviewers included).
    setShownOwner(detailsOwner)
    setDetails(null)
  }
  const detailsOwnerRef = useRef(detailsOwner)
  detailsOwnerRef.current = detailsOwner
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [commentDraftState, setCommentDraftState] = useState<{
    itemId: string | null
    value: string
  }>(() => ({ itemId, value: '' }))
  const commentDraft = commentDraftState.itemId === itemId ? commentDraftState.value : ''
  if (commentDraftState.itemId !== itemId) {
    // Reset before paint so switching items cannot post the prior item’s draft to the new target.
    setCommentDraftState({ itemId, value: '' })
  }
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [resolvingThreadId, setResolvingThreadId] = useState<string | null>(null)
  const [editingDetails, setEditingDetails] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('')
  const [labelOptions, setLabelOptions] = useState<string[] | null>(null)
  const [labelOptionsLoading, setLabelOptionsLoading] = useState(false)
  const [detailsSaving, setDetailsSaving] = useState(false)
  const [reviewerOptions, setReviewerOptions] = useState<GitLabAssignableUser[] | null>(null)
  const [reviewerOptionsLoading, setReviewerOptionsLoading] = useState(false)
  const [reviewerUpdating, setReviewerUpdating] = useState(false)
  const [reviewerDraftId, setReviewerDraftId] = useState('')
  const [inlineCommentFilePath, setInlineCommentFilePath] = useState('')
  const [inlineCommentLine, setInlineCommentLine] = useState('')
  const [inlineCommentBody, setInlineCommentBody] = useState('')
  const [inlineCommentSubmitting, setInlineCommentSubmitting] = useState(false)
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null)
  const [jobTraceById, setJobTraceById] = useState<Record<number, JobTraceState>>({})
  const [retryingJobId, setRetryingJobId] = useState<number | null>(null)
  const [actionInFlight, setActionInFlight] = useState<'close' | 'reopen' | 'merge' | null>(null)
  const mountedRef = useMountedRef()
  // A late provider result may set details/options only while the dialog still targets the owner it began for.
  const claimDetailsOwner = useCallback((): (() => boolean) => {
    const owner = detailsOwnerRef.current
    return () => mountedRef.current && detailsOwnerRef.current === owner
  }, [mountedRef])
  const updateCommentDraft = useCallback(
    (value: string): void => {
      setCommentDraftState({ itemId, value })
    },
    [itemId]
  )

  return {
    actionInFlight,
    bodyDraft,
    claimDetailsOwner,
    commentDraft,
    commentSubmitting,
    details,
    detailsSaving,
    editingDetails,
    error,
    expandedJobId,
    inlineCommentBody,
    inlineCommentFilePath,
    inlineCommentLine,
    inlineCommentSubmitting,
    jobTraceById,
    labelDraft,
    labelOptions,
    labelOptionsLoading,
    loading,
    mountedRef,
    refreshNonce,
    resolvingThreadId,
    retryingJobId,
    reviewerDraftId,
    reviewerOptions,
    reviewerOptionsLoading,
    reviewerUpdating,
    setActionInFlight,
    setBodyDraft,
    setCommentDraftState,
    setCommentSubmitting,
    setDetails,
    setDetailsSaving,
    setEditingDetails,
    setError,
    setExpandedJobId,
    setInlineCommentBody,
    setInlineCommentFilePath,
    setInlineCommentLine,
    setInlineCommentSubmitting,
    setJobTraceById,
    setLabelDraft,
    setLabelOptions,
    setLabelOptionsLoading,
    setLoading,
    setRefreshNonce,
    setResolvingThreadId,
    setRetryingJobId,
    setReviewerDraftId,
    setReviewerOptions,
    setReviewerOptionsLoading,
    setReviewerUpdating,
    setTitleDraft,
    titleDraft,
    updateCommentDraft
  }
}

export type GitLabItemDialogState = ReturnType<typeof useGitLabItemDialogState>
