import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { resolveChecksActionAgent } from '@/lib/source-control-agent-picker'
import type { SourceControlActionId } from '../../../../../shared/source-control-ai-actions'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
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
import { useAppStore } from '@/store'
import { worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'

type ChecksPanelCommentResolutionInput = Pick<
  ChecksPanelControllerState,
  | 'activeWorktree'
  | 'activeWorktreeId'
  | 'branch'
  | 'claimedCommentResolutionRef'
  | 'commentResolutionAckBusy'
  | 'commentsLoading'
  | 'detectedAgentIds'
  | 'pendingCommentResolutionRef'
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
    activeGitLabReview,
    activeReview,
    activeWorktree,
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
    repo,
    resolveReviewThread,
    setAgentComposerState,
    setComments,
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
          iid: activeGitLabReview.number,
          discussionId: threadId,
          resolved: resolve,
          repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree)
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
      activeWorktree,
      setComments
    ]
  )

  const canTargetPRComments = Boolean(repo && prNumber && pr?.prRepo)
  const commentsDisabledReason = canTargetPRComments
    ? undefined
    : translate(
        'auto.components.right.sidebar.checks.panel.content.commentingRequiresGitHubPrTarget',
        'Commenting requires a GitHub PR repository target.'
      )
  const workspace = worktreeLaunchWorkspace(activeWorktreeId ?? '')
  const observation = useAgentMenuObservation(
    activeWorktreeId,
    sourceControlAiActionsVisible,
    useAgentDetectionTargetForWorktree(activeWorktreeId)
  )
  const launchState = useAppStore.getState()
  const noAgentFor = (actionId: SourceControlActionId): boolean =>
    !observation.preferencesPending &&
    detectedAgentIds != null &&
    resolveChecksActionAgent(
      launchState,
      actionId,
      repo?.id,
      workspace,
      detectedAgentIds,
      observation.preferences
    ) == null
  const noEnabledAgentKnown = noAgentFor('resolveConflicts')
  const actionDisabledReason = (actionId: SourceControlActionId): string | undefined =>
    !activeWorktreeId
      ? translate(
          'auto.components.right.sidebar.checks.panel.content.selectWorkspaceBeforeAiAction',
          'Select a workspace before launching an AI action.'
        )
      : noAgentFor(actionId)
        ? translate(
            'auto.components.right.sidebar.source.control.ai.recovery.launch.9bbd9077a2',
            'No enabled AI agents. Configure agents in Settings.'
          )
        : undefined
  const aiActionDisabledReason = actionDisabledReason('resolveConflicts')
  const fixChecksDisabledReason = actionDisabledReason('fixChecks')
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
      : actionDisabledReason('resolveComments')
        ? actionDisabledReason('resolveComments')
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
    detectedAgentsForAI: detectedAgentIds,
    noEnabledAgentKnown,
    aiActionDisabledReason,
    fixChecksDisabledReason,
    resolveCommentsWithAIDisabledReason
  }
}

export type ChecksPanelCommentResolutionState = ReturnType<typeof useChecksPanelCommentResolution>
