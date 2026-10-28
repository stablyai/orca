import { useSavedSourceControlActionStart } from '../use-saved-source-control-action-start'
import { resolveSourceControlActionRecipe } from '../../../../../shared/source-control-ai'
import {
  checksPanelReviewStableKey,
  clearPendingPRCommentAiAck,
  setPendingPRCommentAiAck,
  type PendingPRCommentAiAckGithubTarget
} from '../pr-comments-ai-launch-ack'
import type { ChecksAgentComposerState } from './panel-state-types'
import type { ChecksPanelAiAcknowledgementState } from './use-checks-panel-ai-acknowledgement'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import { toast } from 'sonner'
import { buildResolvePullRequestConflictsPrompt } from '../SourceControl'
import { buildPRCommentsResolutionPrompt } from '../../pr-comments-resolution-prompt'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import type { PRCommentGroup } from '../../../../../shared/pr-comment-groups'
import { translate } from '@/i18n/i18n'

import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelCommentResolutionState } from './use-checks-panel-comment-resolution'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'

type ChecksPanelAiQueueInput = Pick<
  ChecksPanelContextState,
  'activeConflictReview' | 'activeReview' | 'pr' | 'prNumber'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeConnectionId'
    | 'activeSourceControlLaunchPlatform'
    | 'settings'
    | 'asyncResultKeyRef'
    | 'activeWorktree'
    | 'activeWorktreeId'
    | 'activeWorktreePath'
    | 'claimedCommentResolutionRef'
    | 'commentResolutionAckBusyRef'
    | 'commentResolutionLaunchAcceptedRef'
    | 'pendingCommentResolutionRef'
    | 'repo'
    | 'setAgentComposerState'
  > &
  Pick<ChecksPanelCommentResolutionState, 'resolveCommentsWithAIDisabledReason'> &
  Pick<ChecksPanelReviewState, 'sourceControlAiActionsVisible'> &
  Pick<ChecksPanelComposerState, 'stateRequestKey'> &
  Pick<ChecksPanelAiAcknowledgementState, 'commentLaunchCallbacks'>

export function useChecksPanelAiQueue(model: ChecksPanelAiQueueInput) {
  const {
    activeConflictReview,
    activeReview,
    activeWorktree,
    activeWorktreeId,
    activeWorktreePath,
    claimedCommentResolutionRef,
    commentResolutionAckBusyRef,
    commentResolutionLaunchAcceptedRef,
    pendingCommentResolutionRef,
    pr,
    prNumber,
    repo,
    resolveCommentsWithAIDisabledReason,
    setAgentComposerState,
    sourceControlAiActionsVisible,
    stateRequestKey
  } = model
  const savedStart = useSavedSourceControlActionStart()
  const openOrStart = (composer: ChecksAgentComposerState): void => {
    void savedStart.start(() => {
      const recipe = resolveSourceControlActionRecipe({
        settings: model.settings,
        repo,
        actionId: composer.actionId
      })
      const resolution = composer.commentResolution
      pendingCommentResolutionRef.current = resolution ?? null
      claimedCommentResolutionRef.current = null
      commentResolutionLaunchAcceptedRef.current = false
      if (resolution) {
        setPendingPRCommentAiAck(resolution)
      } else {
        clearPendingPRCommentAiAck()
      }
      const callbacks = resolution
        ? model.commentLaunchCallbacks(resolution)
        : {
            onLaunched: () =>
              toast.success(
                translate(
                  'auto.components.right.sidebar.ChecksPanel.a0181a8d76',
                  'Started an AI agent for the conflicts.'
                )
              )
          }
      const launchContext = {
        initialRecipe: recipe,
        worktreeId: activeWorktreeId,
        groupId: activeWorktreeId,
        connectionId: model.activeConnectionId,
        repoId: repo?.id,
        launchPlatform: model.activeSourceControlLaunchPlatform,
        ...callbacks
      }
      return {
        ...launchContext,
        recipe,
        basePrompt: composer.prompt,
        settings: model.settings,
        repo,
        actionId: composer.actionId,
        launchSource: composer.launchSource,
        promptDelivery: 'submit-after-ready',
        onClose: () => {},
        onFallback: () => {
          if (
            checksPanelReviewStableKey(model.asyncResultKeyRef.current) ===
            checksPanelReviewStableKey(stateRequestKey)
          ) {
            setAgentComposerState({ ...composer, launchContext })
          } else if (resolution) {
            if (pendingCommentResolutionRef.current === resolution) {
              pendingCommentResolutionRef.current = null
            }
            clearPendingPRCommentAiAck(resolution)
          }
        }
      }
    })
  }
  // Why: hosted-review conflicts come from the host mergeability check (no local MERGE_HEAD), so the prompt reproduces the merge locally.
  const handleResolveConflictsWithAI = async (): Promise<void> => {
    if (!sourceControlAiActionsVisible || !activeWorktreeId || !activeConflictReview) {
      return
    }
    const conflictFiles = activeConflictReview.conflictSummary?.files ?? []
    openOrStart({
      actionId: 'resolveConflicts',
      title: translate(
        'auto.components.right.sidebar.ChecksPanel.4ede779461',
        'Resolve Review Conflicts With AI'
      ),
      description: translate(
        'auto.components.right.sidebar.ChecksPanel.abf59262fb',
        'Review and edit the full command input before starting an agent.'
      ),
      prompt: buildResolvePullRequestConflictsPrompt({
        reviewKind: activeConflictReview.provider === 'gitlab' ? 'MR' : 'PR',
        baseRef: activeConflictReview.conflictSummary?.baseRef,
        entries: conflictFiles.map((path) => ({ path })),
        worktreePath: activeWorktreePath ?? null
      }),
      launchSource: 'conflict_resolution'
    })
  }

  const handleResolveCommentsWithAI = (selectedGroups: PRCommentGroup[]): void => {
    if (
      !sourceControlAiActionsVisible ||
      !activeWorktreeId ||
      !activeReview ||
      !repo ||
      resolveCommentsWithAIDisabledReason
    ) {
      return
    }
    // Why: re-entering while a launch/ack is still landing would post a second
    // fixing reply on the same threads.
    if (commentResolutionAckBusyRef.current) {
      return
    }
    if (selectedGroups.length === 0) {
      toast.message(
        translate(
          'auto.components.right.sidebar.ChecksPanel.f316a8ca2b',
          'No unresolved comments selected.'
        )
      )
      return
    }
    // Why: pr.prRepo can be missing while comments are still visible; fall back to the PR URL.
    const githubTargetFromPr =
      activeReview.provider === 'github' && prNumber && pr?.prRepo
        ? {
            repoPath: repo.path,
            repoId: repo.id,
            prNumber,
            prRepo: pr.prRepo
          }
        : undefined
    const githubTargetFromUrl = ((): PendingPRCommentAiAckGithubTarget | undefined => {
      if (activeReview.provider !== 'github' || githubTargetFromPr) {
        return undefined
      }
      const link = parseGitHubIssueOrPRLink(activeReview.url || pr?.url || '')
      if (!link || link.type !== 'pr') {
        return undefined
      }
      return {
        repoPath: repo.path,
        repoId: repo.id,
        prNumber: link.number,
        prRepo: {
          owner: link.slug.owner,
          repo: link.slug.repo,
          host: link.slug.host
        }
      }
    })()
    const githubTarget = githubTargetFromPr ?? githubTargetFromUrl
    // Why: resolving needs no prRepo, so a degraded PR entry that only yields a number must
    // still ack by resolving instead of failing every selected thread.
    const githubResolveTarget =
      githubTarget ??
      (activeReview.provider === 'github' && prNumber
        ? { repoPath: repo.path, repoId: repo.id, prNumber }
        : undefined)
    // Why: the ack resolves against this MR after delivery, so pin the iid now — the panel
    // may already be showing a different review by then.
    const gitlabTarget =
      activeReview.provider === 'gitlab'
        ? {
            repoPath: repo.path,
            repoId: repo.id,
            iid: activeReview.number,
            ownerHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree)
          }
        : undefined
    const commentResolution = {
      reviewContextKey: stateRequestKey,
      provider: activeReview.provider,
      selectedGroups: [...selectedGroups],
      githubTarget,
      githubResolveTarget,
      gitlabTarget
    }
    openOrStart({
      actionId: 'resolveComments',
      title: translate(
        'auto.components.right.sidebar.ChecksPanel.d00ebdc402',
        'Resolve {{value0}} Comments With AI',
        { value0: activeReview.provider === 'gitlab' ? 'MR' : 'PR' }
      ),
      // Why: only GitHub with a resolved PR target posts fixing replies; other providers
      // must not be promised a reply the ack never sends. Resolvable threads are acked by
      // resolving alone, so the copy leads with that.
      description:
        githubTarget && activeReview.provider === 'github'
          ? translate(
              'auto.components.right.sidebar.ChecksPanel.5eb2163b6b',
              'Review the prompt before starting an agent. After the prompt is delivered, Orca resolves the selected host threads and replies to comments it cannot resolve.'
            )
          : translate(
              'auto.components.right.sidebar.ChecksPanel.abf59262fb',
              'Review and edit the full command input before starting an agent.'
            ),
      prompt: buildPRCommentsResolutionPrompt({
        reviewKind: activeReview.provider === 'gitlab' ? 'MR' : 'PR',
        reviewNumber: activeReview.number,
        reviewTitle: activeReview.title,
        reviewUrl: activeReview.url,
        groups: selectedGroups,
        worktreePath: activeWorktreePath
      }),
      launchSource: 'task_page',
      commentResolution
    })
  }

  return {
    handleResolveConflictsWithAI,
    handleResolveCommentsWithAI,
    resolveCommentsWithAIDisabledReason: savedStart.isStarting
      ? 'Still finishing the previous comment launch.'
      : resolveCommentsWithAIDisabledReason,
    isResolvingConflictsWithAI: savedStart.isStarting
  }
}

export type ChecksPanelAiQueueState = ReturnType<typeof useChecksPanelAiQueue>
