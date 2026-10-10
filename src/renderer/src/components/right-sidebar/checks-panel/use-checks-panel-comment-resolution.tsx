import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { pickDefaultSourceControlAgent } from '../SourceControl'
import {
  markPRCommentThreadResolved,
  restorePRCommentThreadSnapshot
} from '../pr-comment-thread-resolution'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { resolveGitLabMRDiscussionForChecks } from './gitlab-review-client'
import { clearPendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'

type ChecksPanelCommentResolutionInput = Pick<
  ChecksPanelControllerState,
  | 'activeConnectionId'
  | 'activeWorktreeId'
  | 'branch'
  | 'claimedCommentResolutionRef'
  | 'commentResolutionAckBusy'
  | 'commentsLoading'
  | 'detectedAgentIds'
  | 'pendingCommentResolutionRef'
  | 'remoteDetectedAgentIds'
  | 'repo'
  | 'resolveReviewThread'
  | 'setAgentComposerState'
  | 'setComments'
  | 'settings'
  | 'commentResolutionLaunchAcceptedRef'
> &
  Pick<
    ChecksPanelContextState,
    'activeGitLabReview' | 'activeReview' | 'pr' | 'prCacheKey' | 'prNumber'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult'> &
  Pick<ChecksPanelReviewState, 'sourceControlAiActionsVisible'>

export function useChecksPanelCommentResolution(model: ChecksPanelCommentResolutionInput) {
  const {
    activeConnectionId,
    activeGitLabReview,
    activeReview,
    activeWorktreeId,
    branch,
    claimedCommentResolutionRef,
    commentResolutionAckBusy,
    commentsLoading,
    detectedAgentIds,
    isCurrentAsyncResult,
    pendingCommentResolutionRef,
    pr,
    prCacheKey,
    prNumber,
    remoteDetectedAgentIds,
    repo,
    resolveReviewThread,
    setAgentComposerState,
    setComments,
    settings,
    sourceControlAiActionsVisible,
    commentResolutionLaunchAcceptedRef
  } = model
  const handleResolve = useCallback(
    async (
      threadId: string,
      resolve: boolean,
      options: { notifyOnFailure?: boolean } = {}
    ): Promise<boolean> => {
      const notifyOnFailure = options.notifyOnFailure !== false
      const rollbackThread = (previousThreadComments: PRComment[]): void => {
        setComments((prev) => restorePRCommentThreadSnapshot(prev, previousThreadComments))
      }
      if (repo && activeGitLabReview) {
        let previousThreadComments: PRComment[] = []
        setComments((prev) => {
          previousThreadComments = prev.filter((comment) => comment.threadId === threadId)
          return markPRCommentThreadResolved(prev, threadId, resolve)
        })
        const result = await resolveGitLabMRDiscussionForChecks({
          repoPath: repo.path,
          repoId: repo.id,
          settings,
          iid: activeGitLabReview.number,
          discussionId: threadId,
          resolved: resolve
        })
        if (!result.ok) {
          rollbackThread(previousThreadComments)
          if (notifyOnFailure) {
            toast.error(result.error)
          }
          return false
        }
        return true
      }
      if (!repo || !prNumber) {
        return false
      }
      const requestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr?.prRepo,
        pr?.headSha
      )
      let previousThreadComments: PRComment[] = []
      setComments((prev) => {
        previousThreadComments = prev.filter((comment) => comment.threadId === threadId)
        return markPRCommentThreadResolved(prev, threadId, resolve)
      })
      const ok = await resolveReviewThread(repo.path, prNumber, threadId, resolve, {
        repoId: repo.id,
        prRepo: pr?.prRepo
      })
      if (!isCurrentAsyncResult(requestKey)) {
        return ok
      }
      if (!ok) {
        rollbackThread(previousThreadComments)
        if (notifyOnFailure) {
          toast.error(
            translate(
              'auto.components.right.sidebar.ChecksPanel.5788d1059d',
              'Could not update review thread. Check the GitHub API budget.'
            )
          )
        }
      }
      return ok
    },
    [
      activeGitLabReview,
      branch,
      isCurrentAsyncResult,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      prNumber,
      repo,
      resolveReviewThread,
      settings,
      setComments
    ]
  )

  const canTargetPRComments = Boolean(repo && prNumber && pr?.prRepo)
  const commentsDisabledReason = canTargetPRComments
    ? undefined
    : 'Commenting requires a GitHub PR repository target.'
  const detectedAgentsForAI =
    typeof activeConnectionId === 'string' ? remoteDetectedAgentIds : detectedAgentIds
  const noEnabledAgentKnown =
    detectedAgentsForAI != null &&
    pickDefaultSourceControlAgent(
      settings?.defaultTuiAgent,
      detectedAgentsForAI,
      settings?.disabledTuiAgents
    ) == null
  const aiActionDisabledReason = !activeWorktreeId
    ? 'Select a workspace before launching an AI action.'
    : noEnabledAgentKnown
      ? 'No enabled AI agents. Configure agents in Settings.'
      : undefined
  useEffect(() => {
    if (!sourceControlAiActionsVisible) {
      setAgentComposerState(null)
      pendingCommentResolutionRef.current = null
      claimedCommentResolutionRef.current = null
      commentResolutionLaunchAcceptedRef.current = false
      clearPendingPRCommentAiAck()
    }
  }, [
    sourceControlAiActionsVisible,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    setAgentComposerState
  ])
  const resolveCommentsWithAIDisabledReason = commentResolutionAckBusy
    ? 'Still finishing the previous comment launch.'
    : commentsLoading
      ? 'Comments are still loading.'
      : aiActionDisabledReason
        ? aiActionDisabledReason
        : !activeReview
          ? 'Open a PR or MR before launching an AI action.'
          : !repo
            ? 'Select a repository before launching an AI action.'
            : activeReview.provider === 'github' && !prNumber
              ? 'Open a GitHub PR before resolving comments.'
              : activeReview.provider === 'gitlab' && !activeGitLabReview
                ? 'Open a GitLab MR before resolving comments.'
                : undefined
  return {
    handleResolve,
    canTargetPRComments,
    commentsDisabledReason,
    detectedAgentsForAI,
    noEnabledAgentKnown,
    aiActionDisabledReason,
    resolveCommentsWithAIDisabledReason
  }
}

export type ChecksPanelCommentResolutionState = ReturnType<typeof useChecksPanelCommentResolution>
