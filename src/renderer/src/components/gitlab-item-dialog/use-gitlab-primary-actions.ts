import { useCallback } from 'react'
import { toast } from 'sonner'
import { getCommentBodySubmitState } from '@/lib/comment-body-submit-state'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { showGitLabMutationError } from '../gitlab-item-dialog-parts'
import type { GitLabDialogRepoSelector } from './gitlab-item-dialog-types'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'

export function useGitLabPrimaryActions(
  item: GitLabWorkItem | null,
  itemId: string | null,
  repoSelector: GitLabDialogRepoSelector | null,
  state: GitLabItemDialogState,
  handleRefresh: () => void
) {
  const {
    commentDraft,
    mountedRef,
    setActionInFlight,
    setCommentDraftState,
    setCommentSubmitting
  } = state
  const handleClose = useCallback(async (): Promise<void> => {
    if (!item || !repoSelector || item.type !== 'mr') {
      return
    }
    setActionInFlight('close')
    try {
      const res = await window.api.gl.closeMR({ ...repoSelector, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          toast.success(
            translate('auto.components.GitLabItemDialog.9b11cd233f', 'Closed MR !{{value0}}', {
              value0: item.number
            })
          )
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        showGitLabMutationError(error)
      }
    } finally {
      if (mountedRef.current) {
        setActionInFlight(null)
      }
    }
  }, [handleRefresh, item, mountedRef, repoSelector, setActionInFlight])

  const handleReopen = useCallback(async (): Promise<void> => {
    if (!item || !repoSelector || item.type !== 'mr') {
      return
    }
    setActionInFlight('reopen')
    try {
      const res = await window.api.gl.reopenMR({ ...repoSelector, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          toast.success(
            translate('auto.components.GitLabItemDialog.865ea2703e', 'Reopened MR !{{value0}}', {
              value0: item.number
            })
          )
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        showGitLabMutationError(error)
      }
    } finally {
      if (mountedRef.current) {
        setActionInFlight(null)
      }
    }
  }, [handleRefresh, item, mountedRef, repoSelector, setActionInFlight])

  const handleMerge = useCallback(async (): Promise<void> => {
    if (!item || !repoSelector || item.type !== 'mr') {
      return
    }
    setActionInFlight('merge')
    try {
      const res = await window.api.gl.mergeMR({ ...repoSelector, iid: item.number })
      if (res.ok) {
        if (mountedRef.current) {
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          toast.success(
            translate('auto.components.GitLabItemDialog.e089f62594', 'Merged MR !{{value0}}', {
              value0: item.number
            })
          )
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        showGitLabMutationError(error)
      }
    } finally {
      if (mountedRef.current) {
        setActionInFlight(null)
      }
    }
  }, [handleRefresh, item, mountedRef, repoSelector, setActionInFlight])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty' || !item || !repoSelector) {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.GitLabItemDialog.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setCommentSubmitting(true)
    try {
      // Why: the IPC for issue comments takes `number`, MR takes `iid`.
      // Branch on the item type to hit the right channel.
      const res =
        item.type === 'mr'
          ? await window.api.gl.addMRComment({
              ...repoSelector,
              iid: item.number,
              body: bodyState.body
            })
          : await window.api.gl.addIssueComment({
              ...repoSelector,
              number: item.number,
              body: bodyState.body
            })
      if (res.ok) {
        if (mountedRef.current) {
          setCommentDraftState((current) =>
            current.itemId === itemId ? { itemId, value: '' } : current
          )
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          handleRefresh()
        }
      } else {
        if (mountedRef.current) {
          toast.error(res.error)
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        showGitLabMutationError(error)
      }
    } finally {
      if (mountedRef.current) {
        setCommentSubmitting(false)
      }
    }
  }, [
    commentDraft,
    handleRefresh,
    item,
    itemId,
    mountedRef,
    repoSelector,
    setCommentDraftState,
    setCommentSubmitting
  ])

  return { handleClose, handleMerge, handleReopen, handleSubmitComment }
}

export type GitLabPrimaryActions = ReturnType<typeof useGitLabPrimaryActions>
