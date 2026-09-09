/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: GitLab item dialogs reset draft/provider state and hydrate details from GitLab IPC when the selected item identity changes. */
import { useEffect } from 'react'
import type { GitLabWorkItem, GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
import type { GitLabDialogRepoSelector } from './gitlab-item-dialog-types'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'

export function useGitLabItemDetailsEffect(
  item: GitLabWorkItem | null,
  repoSelector: GitLabDialogRepoSelector | null,
  state: GitLabItemDialogState
): void {
  const { refreshNonce, setDetails, setEditingDetails, setError, setLoading } = state
  useEffect(() => {
    if (!item || !repoSelector) {
      setDetails(null)
      setLoading(false)
      setError(null)
      setEditingDetails(false)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    void window.api.gl
      .workItemDetails({ ...repoSelector, iid: item.number, type: item.type })
      .then((data) => {
        if (stale) {
          return
        }
        if (!data) {
          setError('Item not found.')
          return
        }
        setDetails(data as GitLabWorkItemDetails)
      })
      .catch((err) => {
        if (!stale) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [item, refreshNonce, repoSelector, setDetails, setEditingDetails, setError, setLoading])
}

export function useGitLabItemScopeResetEffect(
  itemId: string | null,
  state: GitLabItemDialogState
): void {
  const {
    setBodyDraft,
    setEditingDetails,
    setExpandedJobId,
    setInlineCommentBody,
    setInlineCommentFilePath,
    setInlineCommentLine,
    setInlineCommentSubmitting,
    setJobTraceById,
    setLabelDraft,
    setLabelOptions,
    setLabelOptionsLoading,
    setRetryingJobId,
    setReviewerDraftId,
    setReviewerOptions,
    setReviewerOptionsLoading,
    setReviewerUpdating,
    setTitleDraft
  } = state
  // Why: clear item-scoped dialog state when the sheet target changes. The
  // top-level comment draft is reconciled during render so it cannot flash stale.
  useEffect(() => {
    setEditingDetails(false)
    setTitleDraft('')
    setBodyDraft('')
    setLabelDraft('')
    setLabelOptions(null)
    setLabelOptionsLoading(false)
    setReviewerOptions(null)
    setReviewerOptionsLoading(false)
    setReviewerUpdating(false)
    setReviewerDraftId('')
    setInlineCommentFilePath('')
    setInlineCommentLine('')
    setInlineCommentBody('')
    setInlineCommentSubmitting(false)
    setExpandedJobId(null)
    setJobTraceById({})
    setRetryingJobId(null)
  }, [
    itemId,
    setBodyDraft,
    setEditingDetails,
    setExpandedJobId,
    setInlineCommentBody,
    setInlineCommentFilePath,
    setInlineCommentLine,
    setInlineCommentSubmitting,
    setJobTraceById,
    setLabelDraft,
    setLabelOptions,
    setLabelOptionsLoading,
    setRetryingJobId,
    setReviewerDraftId,
    setReviewerOptions,
    setReviewerOptionsLoading,
    setReviewerUpdating,
    setTitleDraft
  ])
}
