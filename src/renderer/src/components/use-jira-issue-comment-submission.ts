import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { JiraComment, JiraIssue } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getCommentBodySubmitState } from '@/lib/comment-body-submit-state'
import { translate } from '@/i18n/i18n'
import { jiraAddIssueCommentForTarget } from '@/runtime/runtime-jira-client'

type JiraIssueCommentSubmissionArgs = {
  commentDraft: string
  commentSubmitting: boolean
  displayed: JiraIssue | null
  optimisticCommentsRef: RefObject<JiraComment[]>
  owner: RuntimeClientTarget
  requestIdRef: RefObject<number>
  setCommentDraft: (draft: string) => void
  setCommentSubmitting: (submitting: boolean) => void
  setComments: Dispatch<SetStateAction<JiraComment[]>>
}

export function useJiraIssueCommentSubmission({
  commentDraft,
  commentSubmitting,
  displayed,
  optimisticCommentsRef,
  owner,
  requestIdRef,
  setCommentDraft,
  setCommentSubmitting,
  setComments
}: JiraIssueCommentSubmissionArgs): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    if (!displayed || commentSubmitting) {
      return
    }
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.JiraIssueWorkspace.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setCommentSubmitting(true)
    const requestId = requestIdRef.current
    try {
      const result = await jiraAddIssueCommentForTarget(
        owner,
        displayed.key,
        bodyState.body,
        displayed.siteId
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      if (requestId !== requestIdRef.current) {
        return
      }
      const comment: JiraComment = {
        id: result.id || createBrowserUuid(),
        body: bodyState.body,
        createdAt: new Date().toISOString(),
        user: {
          accountId: 'local',
          displayName: translate('auto.components.issueComments.you', 'You')
        }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((previous) => [...previous, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.JiraIssueWorkspace.fa132c8aed', 'Failed to add comment.')
      )
    } finally {
      if (requestId === requestIdRef.current) {
        setCommentSubmitting(false)
      }
    }
  }, [
    commentDraft,
    commentSubmitting,
    displayed,
    optimisticCommentsRef,
    owner,
    requestIdRef,
    setCommentDraft,
    setCommentSubmitting,
    setComments
  ])
}
