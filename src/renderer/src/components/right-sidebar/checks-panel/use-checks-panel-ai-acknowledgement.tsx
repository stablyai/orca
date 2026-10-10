import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { mergePRCommentIntoList } from '@/store/github/pr-comment-cache'
import {
  acknowledgePRCommentsAfterAiLaunch,
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply,
  checksPanelReviewStableKey,
  hasPRCommentGroupNeedingReply,
  resolvePRReviewReplyThreadId,
  setPendingPRCommentAiAck,
  takePendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelReviewDataState } from './use-checks-panel-review-data'
import type { ChecksPanelPollingState } from './use-checks-panel-polling'
import { buildSnapshottedThreadResolver } from '../pr-comment-snapshotted-thread-resolver'
import { markPRCommentThreadResolved } from '../pr-comment-thread-resolution'
import { resolveGitLabMRDiscussionForChecks } from './gitlab-review-client'
import { clearPRCommentsListSelection } from '../pr-comments-list-selection'
import { translate } from '@/i18n/i18n'
import type { ChecksAgentComposerState } from './panel-state-types'
import type { ChecksPanelReview } from '../checks-panel-review'

type ChecksPanelAiAcknowledgementInput = Pick<
  ChecksPanelControllerState,
  | 'addPRConversationComment'
  | 'addPRReviewCommentReply'
  | 'asyncResultKeyRef'
  | 'claimedCommentResolutionRef'
  | 'commentsRef'
  | 'commentsSelectionClearTokenRef'
  | 'pendingCommentResolutionRef'
  | 'resolveReviewThread'
  | 'setCommentResolutionAckBusyNow'
  | 'setComments'
  | 'setCommentsSelectionClearRequest'
  | 'settings'
  | 'commentResolutionLaunchAcceptedRef'
> &
  Pick<ChecksPanelReviewDataState, 'fetchComments'> &
  Pick<ChecksPanelPollingState, 'fetchGitLabDetails'>

export function useChecksPanelAiAcknowledgement(model: ChecksPanelAiAcknowledgementInput) {
  const {
    addPRConversationComment,
    addPRReviewCommentReply,
    asyncResultKeyRef,
    claimedCommentResolutionRef,
    commentsRef,
    commentsSelectionClearTokenRef,
    fetchComments,
    fetchGitLabDetails,
    pendingCommentResolutionRef,
    resolveReviewThread,
    setCommentResolutionAckBusyNow,
    setComments,
    setCommentsSelectionClearRequest,
    settings,
    commentResolutionLaunchAcceptedRef
  } = model
  const clearSentCommentSelection = useCallback(
    (reviewContextKey: string): void => {
      clearPRCommentsListSelection(reviewContextKey)
      commentsSelectionClearTokenRef.current += 1
      setCommentsSelectionClearRequest({
        contextKey: reviewContextKey,
        token: commentsSelectionClearTokenRef.current
      })
    },
    [commentsSelectionClearTokenRef, setCommentsSelectionClearRequest]
  )

  const refreshCommentsAfterBulkResolve = useCallback(
    async (provider: ChecksPanelReview['provider']): Promise<void> => {
      if (provider === 'gitlab') {
        await fetchGitLabDetails({ commitAsCurrent: true })
        return
      }
      await fetchComments({ force: true })
    },
    [fetchComments, fetchGitLabDetails]
  )

  const resolveSelectedThreadsAfterLaunch = useCallback(
    async (resolution: NonNullable<ChecksAgentComposerState['commentResolution']>) => {
      clearSentCommentSelection(resolution.reviewContextKey)
      // Why: ignore headSha churn; only abort resolve/UI refresh if the user left this PR/panel.
      const launchStableKey = checksPanelReviewStableKey(resolution.reviewContextKey)
      // Why: the host calls keep the snapshotted target, but every UI mutation must belong
      // to the review the panel is showing now — otherwise replies land in another PR's list.
      const isPanelStillOnLaunchReview = (): boolean =>
        checksPanelReviewStableKey(asyncResultKeyRef.current) === launchStableKey
      const githubTarget = resolution.githubTarget
      const canReplyOnHost = resolution.provider === 'github' && githubTarget != null
      // Why: only GitHub posts fixing replies today; a GitLab MR reaching replied=0 is expected,
      // and a missing reply target only matters when something in the selection needs a reply.
      let lastHostError =
        resolution.provider === 'github' &&
        githubTarget == null &&
        hasPRCommentGroupNeedingReply(resolution.selectedGroups)
          ? translate(
              'auto.components.right.sidebar.ChecksPanel.7e4b2a19c0',
              'Could not resolve the GitHub PR to reply on.'
            )
          : undefined
      const resolveSnapshottedThread = buildSnapshottedThreadResolver({
        provider: resolution.provider,
        githubResolveTarget: resolution.githubResolveTarget,
        gitlabTarget: resolution.gitlabTarget,
        resolveReviewThread,
        resolveGitLabDiscussion: (args) =>
          resolveGitLabMRDiscussionForChecks({ ...args, settings }),
        isPanelStillOnLaunchReview,
        onResolvedOptimistically: (threadId) => {
          setComments((prev) => markPRCommentThreadResolved(prev, threadId, true))
        },
        onResolveFailed: ({ threadId, error }) => {
          lastHostError =
            error ||
            translate(
              'auto.components.right.sidebar.ChecksPanel.430f1a62d4',
              'Could not resolve the selected thread on the host.'
            )
          console.warn('Post-launch thread resolve failed:', threadId, error)
        }
      })
      const counts = await acknowledgePRCommentsAfterAiLaunch({
        groups: resolution.selectedGroups,
        deps: {
          resolveThread: resolveSnapshottedThread,
          canReply: canReplyOnHost,
          replyInThread: async (comment, body) => {
            if (!githubTarget || !canPostPRReviewThreadReply(comment)) {
              return false
            }
            try {
              const parentThreadId =
                resolvePRReviewReplyThreadId({
                  parent: comment,
                  existingComments: commentsRef.current
                }) ?? comment.threadId
              const result = await addPRReviewCommentReply(
                githubTarget.repoPath,
                githubTarget.prNumber,
                comment.id,
                body,
                {
                  repoId: githubTarget.repoId,
                  prRepo: githubTarget.prRepo,
                  threadId: parentThreadId,
                  path: comment.path,
                  line: comment.line
                }
              )
              if (result.ok) {
                // Why: force threadId/path onto the optimistic row so the sidebar groups it
                // under the parent immediately (API payload may omit them).
                if (isPanelStillOnLaunchReview()) {
                  setComments((prev) =>
                    mergePRCommentIntoList(
                      prev,
                      attachPRReviewReplyParent(result.comment, {
                        ...comment,
                        threadId: parentThreadId
                      })
                    )
                  )
                }
                return true
              }
              lastHostError = result.error
              console.warn('In-thread fixing reply failed:', result.error)
              return false
            } catch (err) {
              lastHostError = err instanceof Error ? err.message : String(err)
              console.warn('Failed to post in-thread fixing reply for review comment:', err)
              return false
            }
          },
          // Why: CodeRabbit / review-summary / conversation comments have no nested-reply
          // API, so the ack sends one combined body for all of them.
          replyAsConversation: async (body) => {
            if (!githubTarget) {
              return false
            }
            try {
              const result = await addPRConversationComment(
                githubTarget.repoPath,
                githubTarget.prNumber,
                body,
                {
                  repoId: githubTarget.repoId,
                  prRepo: githubTarget.prRepo
                }
              )
              if (result.ok) {
                if (isPanelStillOnLaunchReview()) {
                  setComments((prev) => mergePRCommentIntoList(prev, result.comment))
                }
                return true
              }
              lastHostError = result.error
              console.warn('Conversation fixing reply failed:', result.error)
              return false
            } catch (err) {
              lastHostError = err instanceof Error ? err.message : String(err)
              console.warn('Failed to post conversation fixing reply for review comment:', err)
              return false
            }
          }
        }
      })

      if (isPanelStillOnLaunchReview()) {
        await refreshCommentsAfterBulkResolve(resolution.provider)
      }

      // Why: surface the underlying API error when replies were possible but none landed.
      // Resolvable threads are acked by resolving, so replied=0 is correct when nothing needed one.
      const repliedNoneDespiteHostSupport =
        canReplyOnHost &&
        counts.replied === 0 &&
        hasPRCommentGroupNeedingReply(resolution.selectedGroups)
      if (counts.failed > 0 || repliedNoneDespiteHostSupport || lastHostError) {
        toast.error(
          translate(
            'auto.components.right.sidebar.ChecksPanel.f273f2271c',
            'Started the agent. Marked {{value0}} resolved, replied to {{value1}}, skipped {{value2}}, failed {{value3}}.{{value4}}',
            {
              value0: counts.resolved,
              value1: counts.replied,
              value2: counts.skipped,
              value3: counts.failed,
              value4: lastHostError ? ` ${lastHostError}` : ''
            }
          )
        )
        return
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.ChecksPanel.aa95b81a3a',
          'Started the agent. Marked {{value0}} resolved, replied to {{value1}}, skipped {{value2}}, failed {{value3}}.',
          {
            value0: counts.resolved,
            value1: counts.replied,
            value2: counts.skipped,
            value3: counts.failed
          }
        )
      )
    },
    [
      addPRConversationComment,
      addPRReviewCommentReply,
      clearSentCommentSelection,
      refreshCommentsAfterBulkResolve,
      resolveReviewThread,
      settings,
      commentsRef,
      setComments,
      asyncResultKeyRef
    ]
  )

  /**
   * Tab created: park the payload so panel churn during submit-after-ready cannot drop it.
   * Posts nothing — fixing replies and resolves are irreversible and wait for delivery.
   */
  const claimPendingCommentResolutionForLaunch = useCallback((): void => {
    const pendingResolution = takePendingPRCommentAiAck() ?? pendingCommentResolutionRef.current
    pendingCommentResolutionRef.current = null
    if (!pendingResolution) {
      return
    }
    claimedCommentResolutionRef.current = pendingResolution
    commentResolutionLaunchAcceptedRef.current = true
    setCommentResolutionAckBusyNow(true)
  }, [
    setCommentResolutionAckBusyNow,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef
  ])

  /** Launch failed after the tab existed: hand the payload back for a retry, post nothing. */
  const releaseClaimedCommentResolutionAfterFailedLaunch = useCallback((): void => {
    const claimed = claimedCommentResolutionRef.current
    claimedCommentResolutionRef.current = null
    commentResolutionLaunchAcceptedRef.current = false
    if (claimed) {
      pendingCommentResolutionRef.current = claimed
      setPendingPRCommentAiAck(claimed)
    }
    setCommentResolutionAckBusyNow(false)
  }, [
    setCommentResolutionAckBusyNow,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef
  ])

  /** Prompt reached the agent: only now may Orca write to the host. */
  const consumeClaimedCommentResolutionAfterDelivery = useCallback((): void => {
    const resolution =
      claimedCommentResolutionRef.current ??
      takePendingPRCommentAiAck() ??
      pendingCommentResolutionRef.current
    claimedCommentResolutionRef.current = null
    pendingCommentResolutionRef.current = null
    commentResolutionLaunchAcceptedRef.current = false
    if (!resolution) {
      setCommentResolutionAckBusyNow(false)
      return
    }
    setCommentResolutionAckBusyNow(true)
    void resolveSelectedThreadsAfterLaunch(resolution)
      .catch((err) => {
        console.warn('Failed to resolve/reply on selected review comments after AI launch:', err)
        toast.error(
          translate(
            'auto.components.right.sidebar.ChecksPanel.495b2f8c4b',
            'Started the agent, but could not resolve or reply on the selected comments.'
          )
        )
      })
      .finally(() => setCommentResolutionAckBusyNow(false))
  }, [
    resolveSelectedThreadsAfterLaunch,
    setCommentResolutionAckBusyNow,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef
  ])
  // Why: auto-start can capture a stale callback; always call the latest consumer.
  const consumeClaimedCommentResolutionAfterDeliveryRef = useRef(
    consumeClaimedCommentResolutionAfterDelivery
  )
  const claimPendingCommentResolutionForLaunchRef = useRef(claimPendingCommentResolutionForLaunch)
  const releaseClaimedCommentResolutionAfterFailedLaunchRef = useRef(
    releaseClaimedCommentResolutionAfterFailedLaunch
  )
  useEffect(() => {
    consumeClaimedCommentResolutionAfterDeliveryRef.current =
      consumeClaimedCommentResolutionAfterDelivery
    claimPendingCommentResolutionForLaunchRef.current = claimPendingCommentResolutionForLaunch
    releaseClaimedCommentResolutionAfterFailedLaunchRef.current =
      releaseClaimedCommentResolutionAfterFailedLaunch
  }, [
    consumeClaimedCommentResolutionAfterDelivery,
    claimPendingCommentResolutionForLaunch,
    releaseClaimedCommentResolutionAfterFailedLaunch
  ])
  const handleLaunchAccepted = useCallback((): void => {
    claimPendingCommentResolutionForLaunchRef.current()
  }, [])
  const handleLaunchAborted = useCallback((): void => {
    releaseClaimedCommentResolutionAfterFailedLaunchRef.current()
  }, [])
  return {
    clearSentCommentSelection,
    refreshCommentsAfterBulkResolve,
    resolveSelectedThreadsAfterLaunch,
    handleLaunchAccepted,
    handleLaunchAborted,
    consumeClaimedCommentResolutionAfterDeliveryRef
  }
}

export type ChecksPanelAiAcknowledgementState = ReturnType<typeof useChecksPanelAiAcknowledgement>
