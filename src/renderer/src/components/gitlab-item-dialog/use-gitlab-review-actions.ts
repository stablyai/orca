import { useCallback } from 'react'
import { toast } from 'sonner'
import { getCommentBodySubmitState } from '@/lib/comment-body-submit-state'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GitLabAssignableUser, GitLabWorkItem } from '../../../../shared/gitlab-types'
import { dedupeGitLabUsers, showGitLabMutationError } from '../gitlab-item-dialog-parts'
import type { GitLabDialogRepoSelector } from './gitlab-item-dialog-types'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'

export function useGitLabReviewActions(
  item: GitLabWorkItem | null,
  repoSelector: GitLabDialogRepoSelector | null,
  state: GitLabItemDialogState
) {
  const {
    details,
    inlineCommentBody,
    inlineCommentFilePath,
    inlineCommentLine,
    mountedRef,
    reviewerOptions,
    reviewerOptionsLoading,
    setDetails,
    setInlineCommentBody,
    setInlineCommentSubmitting,
    setResolvingThreadId,
    setReviewerDraftId,
    setReviewerOptions,
    setReviewerOptionsLoading,
    setReviewerUpdating
  } = state
  const loadGitLabReviewerOptions = useCallback(async (): Promise<void> => {
    if (!repoSelector || reviewerOptions !== null || reviewerOptionsLoading) {
      return
    }
    setReviewerOptionsLoading(true)
    try {
      const users = await window.api.gl.listAssignableUsers(repoSelector)
      if (mountedRef.current) {
        setReviewerOptions(dedupeGitLabUsers(users))
      }
    } catch {
      if (mountedRef.current) {
        setReviewerOptions([])
      }
    } finally {
      if (mountedRef.current) {
        setReviewerOptionsLoading(false)
      }
    }
  }, [
    mountedRef,
    repoSelector,
    reviewerOptions,
    reviewerOptionsLoading,
    setReviewerOptions,
    setReviewerOptionsLoading
  ])

  const handleSetReviewers = useCallback(
    async (nextReviewers: GitLabAssignableUser[]): Promise<void> => {
      if (!repoSelector || !item || !details || item.type !== 'mr') {
        return
      }
      const reviewerIds = nextReviewers
        .map((reviewer) => reviewer.id)
        .filter((id): id is number => typeof id === 'number')
      if (reviewerIds.length !== nextReviewers.length) {
        toast.error(
          translate(
            'auto.components.GitLabItemDialog.ceaf7c30c7',
            'Reviewer id is unavailable for this GitLab user.'
          )
        )
        return
      }
      setReviewerUpdating(true)
      try {
        const result = await window.api.gl.updateMRReviewers({
          ...repoSelector,
          iid: item.number,
          reviewerIds,
          projectRef: details.item.projectRef ?? item.projectRef ?? null
        })
        if (!mountedRef.current) {
          return
        }
        if (result.ok) {
          setDetails((current) =>
            current ? { ...current, reviewers: dedupeGitLabUsers(result.reviewers) } : current
          )
          setReviewerDraftId('')
          setReviewerOptions((current) =>
            current ? dedupeGitLabUsers([...current, ...result.reviewers]) : current
          )
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
        } else {
          toast.error(result.error)
        }
      } catch (error) {
        if (mountedRef.current) {
          showGitLabMutationError(error)
        }
      } finally {
        if (mountedRef.current) {
          setReviewerUpdating(false)
        }
      }
    },
    [
      details,
      item,
      mountedRef,
      repoSelector,
      setDetails,
      setReviewerDraftId,
      setReviewerOptions,
      setReviewerUpdating
    ]
  )

  const handleSubmitInlineComment = useCallback(async (): Promise<void> => {
    if (!repoSelector || !item || !details || item.type !== 'mr') {
      return
    }
    const file = (details.files ?? []).find((row) => row.path === inlineCommentFilePath)
    const line = Number.parseInt(inlineCommentLine, 10)
    const bodyState = getCommentBodySubmitState(inlineCommentBody)
    if (!file || !Number.isFinite(line) || line <= 0 || bodyState.status === 'empty') {
      toast.error(
        translate(
          'auto.components.GitLabItemDialog.00d0d25825',
          'File, line, and comment are required.'
        )
      )
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
    if (!details.baseSha || !details.startSha || !details.headSha) {
      toast.error(
        translate(
          'auto.components.GitLabItemDialog.ffdd9a78e1',
          'MR diff refs are unavailable for inline comments.'
        )
      )
      return
    }
    setInlineCommentSubmitting(true)
    try {
      const result = await window.api.gl.addMRInlineComment({
        ...repoSelector,
        iid: item.number,
        projectRef: details.item.projectRef ?? item.projectRef ?? null,
        input: {
          body: bodyState.body,
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          line,
          baseSha: details.baseSha,
          startSha: details.startSha,
          headSha: details.headSha
        }
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setDetails((current) =>
          current ? { ...current, comments: [...current.comments, result.comment] } : current
        )
        setInlineCommentBody('')
        useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
        toast.success(
          translate('auto.components.GitLabItemDialog.60c13320c4', 'Inline comment added')
        )
      } else {
        toast.error(result.error)
      }
    } catch (error) {
      if (mountedRef.current) {
        showGitLabMutationError(error)
      }
    } finally {
      if (mountedRef.current) {
        setInlineCommentSubmitting(false)
      }
    }
  }, [
    details,
    inlineCommentBody,
    inlineCommentFilePath,
    inlineCommentLine,
    item,
    mountedRef,
    repoSelector,
    setDetails,
    setInlineCommentBody,
    setInlineCommentSubmitting
  ])

  const handleResolveDiscussion = useCallback(
    async (threadId: string, resolved: boolean): Promise<void> => {
      if (!item || !repoSelector || item.type !== 'mr') {
        return
      }
      setResolvingThreadId(threadId)
      try {
        const res = await window.api.gl.resolveMRDiscussion({
          ...repoSelector,
          iid: item.number,
          discussionId: threadId,
          resolved
        })
        if (res.ok) {
          if (mountedRef.current) {
            setDetails((current) =>
              current
                ? {
                    ...current,
                    comments: current.comments.map((comment) =>
                      comment.threadId === threadId ? { ...comment, isResolved: resolved } : comment
                    )
                  }
                : current
            )
            useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
          }
        } else if (mountedRef.current) {
          toast.error(res.error)
        }
      } catch (error) {
        if (mountedRef.current) {
          showGitLabMutationError(error)
        }
      } finally {
        if (mountedRef.current) {
          setResolvingThreadId(null)
        }
      }
    },
    [item, repoSelector, mountedRef, setDetails, setResolvingThreadId]
  )

  return {
    handleResolveDiscussion,
    handleSetReviewers,
    handleSubmitInlineComment,
    loadGitLabReviewerOptions
  }
}

export type GitLabReviewActions = ReturnType<typeof useGitLabReviewActions>
