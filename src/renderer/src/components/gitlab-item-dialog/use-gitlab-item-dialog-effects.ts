import { translate } from '@/i18n/i18n'
import { gitLabApiFor } from '@/runtime/repository-gitlab/gitlab-owner-api'
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
    void gitLabApiFor(repoSelector)
      .workItemDetails({ ...repoSelector, iid: item.number, type: item.type })
      .then((data) => {
        if (stale) {
          return
        }
        if (!data) {
          // Main returns null for any failed read, not only a missing item.
          setError(
            translate(
              'auto.components.GitLabItemDialog.itemLoadFailed',
              'Could not load this item. Refresh to try again.'
            )
          )
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
  detailsOwner: string | null,
  state: GitLabItemDialogState
): void {
  const {
    setActionInFlight,
    setBodyDraft,
    setCommentSubmitting,
    setDetailsSaving,
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
  // Reset item-scoped provider state here; render already resets the top-level draft before paint.
  // Busy flags too: a write for the previous target no longer releases them once the target changes.
  useEffect(() => {
    setEditingDetails(false)
    setDetailsSaving(false)
    setActionInFlight(null)
    setCommentSubmitting(false)
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
    detailsOwner,
    setActionInFlight,
    setBodyDraft,
    setCommentSubmitting,
    setDetailsSaving,
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
