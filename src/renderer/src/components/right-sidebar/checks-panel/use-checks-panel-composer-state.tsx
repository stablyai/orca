import { useCallback, useEffect } from 'react'
import { useCreatePullRequestDialogFields } from '../useCreatePullRequestDialogFields'
import { useHostedReviewStackParent } from '../useHostedReviewStackParent'
import { shouldHydratePullRequestGenerationResult } from '@/store/slices/pull-request-generation'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey,
  shouldCommitChecksPanelAsyncResult
} from '../checks-panel-async-result-key'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelGenerationState } from './use-checks-panel-generation'
import {
  checksPanelReviewStableKey,
  clearPendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'

type ChecksPanelComposerStateInput = Pick<
  ChecksPanelContextState,
  'activeGitLabReview' | 'hostedReviewCacheKey' | 'pr' | 'prCacheKey' | 'prNumber'
> &
  Pick<
    ChecksPanelReviewState,
    | 'activePullRequestGenerationKey'
    | 'activePullRequestGenerationRecord'
    | 'activePullRequestGenerationSeedRestoreKey'
    | 'createComposerOpen'
    | 'hostedReviewCreateProvider'
    | 'hostedReviewCreation'
    | 'prCreationDefaults'
    | 'sourceControlAiActionsVisible'
  > &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktreeId'
    | 'activeWorktreePath'
    | 'agentComposerState'
    | 'asyncResultKeyRef'
    | 'branch'
    | 'fetchHostedReviewForBranch'
    | 'isCreatingPr'
    | 'repo'
    | 'setAgentComposerState'
    | 'setCreatePrError'
    | 'ownerSettings'
    | 'pendingCommentResolutionRef'
    | 'claimedCommentResolutionRef'
    | 'commentResolutionLaunchAcceptedRef'
    | 'updatePullRequestGenerationRecord'
  > &
  Pick<
    ChecksPanelGenerationState,
    | 'handleCancelGeneratePullRequestFieldsForActive'
    | 'handleGeneratePullRequestFieldsForActive'
    | 'handlePullRequestGenerationSeedRestored'
  >

export function useChecksPanelComposerState(model: ChecksPanelComposerStateInput) {
  const {
    activeGitLabReview,
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    activePullRequestGenerationSeedRestoreKey,
    activeWorktreeId,
    activeWorktreePath,
    agentComposerState,
    asyncResultKeyRef,
    branch,
    createComposerOpen,
    fetchHostedReviewForBranch,
    handleCancelGeneratePullRequestFieldsForActive,
    handleGeneratePullRequestFieldsForActive,
    handlePullRequestGenerationSeedRestored,
    hostedReviewCacheKey,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    isCreatingPr,
    pr,
    prCacheKey,
    prCreationDefaults,
    prNumber,
    repo,
    setAgentComposerState,
    setCreatePrError,
    sourceControlAiActionsVisible,
    ownerSettings,
    pendingCommentResolutionRef,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    updatePullRequestGenerationRecord
  } = model
  const {
    aiGenerationEnabled: prAiGenerationEnabled,
    base: prBase,
    setBase: setPrBase,
    title: prTitle,
    setTitle: setPrTitle,
    body: prBody,
    setBody: setPrBody,
    draft: prDraft,
    setDraft: setPrDraft,
    stackedCreationSupported: prStackedCreationSupported,
    repoDefaultBaseRef: prRepoDefaultBaseRef,
    baseQuery: prBaseQuery,
    setBaseQuery: setPrBaseQuery,
    baseResults: prBaseResults,
    setBaseResults: setPrBaseResults,
    baseSearchPending: prBaseSearchPending,
    baseSearchError: prBaseSearchError,
    generating: prGenerating,
    generateError: prGenerateError,
    generateDisabled: prGenerateDisabled,
    generateDisabledReason: prGenerateDisabledReason,
    handleGenerate: handleGeneratePullRequestFields,
    handleCancelGenerate: handleCancelGeneratePullRequestFields,
    applyGeneratedFields: applyGeneratedPullRequestFields,
    initializedFromEligibility: pullRequestFieldsInitialized
  } = useCreatePullRequestDialogFields({
    open: createComposerOpen,
    repoId: repo?.id ?? '',
    worktreeId: activeWorktreeId,
    worktreePath: activeWorktreePath ?? '',
    branch,
    eligibility: hostedReviewCreation,
    repo,
    settings: ownerSettings,
    submitting: isCreatingPr,
    prCreationDefaults,
    sourceControlAiActionsVisible,
    // Preserve the draft when a hard refresh error hides the composer so title/body/base survive recovery for the same context.
    retainDraftWhenClosed: true,
    generation: {
      generating: activePullRequestGenerationRecord?.status === 'running',
      generateError: activePullRequestGenerationRecord?.error ?? null,
      seedRestoreKey: activePullRequestGenerationSeedRestoreKey,
      seed: activePullRequestGenerationRecord?.seed ?? null,
      seedFieldRevisions: activePullRequestGenerationRecord?.seedFieldRevisions ?? null,
      onSeedRestored: handlePullRequestGenerationSeedRestored,
      onGenerate: (fields, fieldRevisions, overrides) => {
        void handleGeneratePullRequestFieldsForActive(fields, fieldRevisions, overrides)
      },
      onCancelGenerate: handleCancelGeneratePullRequestFieldsForActive
    }
  })
  const stackParentReview = useHostedReviewStackParent({
    enabled: hostedReviewCreateProvider === 'github' && prStackedCreationSupported,
    repoPath: repo?.path ?? '',
    repoId: repo?.id ?? null,
    base: prBase,
    // Why: the repo default, not eligibility's defaultBaseRef — that one resolves to
    // the worktree's own base, which is exactly the branch a stacked PR targets.
    repoDefaultBase: prRepoDefaultBaseRef,
    head: branch,
    fetchHostedReviewForBranch
  })
  useEffect(() => {
    // Why: PR generation can finish while this composer is hidden by a worktree switch; hydrate once the original composer is visible again.
    if (
      !activePullRequestGenerationKey ||
      !activePullRequestGenerationRecord ||
      activePullRequestGenerationRecord.status !== 'succeeded' ||
      !activePullRequestGenerationRecord.result ||
      activePullRequestGenerationRecord.hydrated ||
      !pullRequestFieldsInitialized
    ) {
      return
    }
    if (
      !shouldHydratePullRequestGenerationResult({
        record: activePullRequestGenerationRecord
      })
    ) {
      return
    }
    applyGeneratedPullRequestFields(
      activePullRequestGenerationRecord.result,
      activePullRequestGenerationRecord.seedFieldRevisions
    )
    updatePullRequestGenerationRecord(activePullRequestGenerationKey, (record) => {
      if (
        !record ||
        record.context.requestId !== activePullRequestGenerationRecord.context.requestId
      ) {
        return null
      }
      return {
        ...record,
        hydrated: true
      }
    })
  }, [
    activePullRequestGenerationKey,
    activePullRequestGenerationRecord,
    applyGeneratedPullRequestFields,
    pullRequestFieldsInitialized,
    updatePullRequestGenerationRecord
  ])
  const handlePrBaseChange = useCallback(
    (value: string): void => {
      setCreatePrError(null)
      setPrBase(value)
    },
    [setPrBase, setCreatePrError]
  )
  const handlePrTitleChange = useCallback(
    (value: string): void => {
      setCreatePrError(null)
      setPrTitle(value)
    },
    [setPrTitle, setCreatePrError]
  )
  const stateRequestKey =
    repo && branch
      ? activeGitLabReview
        ? checksPanelHostedReviewAsyncResultKey(
            hostedReviewCacheKey,
            branch,
            activeGitLabReview.provider,
            activeGitLabReview.number,
            activeGitLabReview.headSha
          )
        : checksPanelAsyncResultKey(prCacheKey, branch, prNumber, pr?.prRepo, pr?.headSha)
      : ''
  asyncResultKeyRef.current = stateRequestKey

  const isCurrentAsyncResult = useCallback(
    (requestKey: string) =>
      shouldCommitChecksPanelAsyncResult(asyncResultKeyRef.current, requestKey),
    [asyncResultKeyRef]
  )
  useEffect(() => {
    // Why: compare without headSha — PR head can move while the agent is still starting.
    if (
      agentComposerState?.commentResolution &&
      checksPanelReviewStableKey(agentComposerState.commentResolution.reviewContextKey) !==
        checksPanelReviewStableKey(stateRequestKey)
    ) {
      setAgentComposerState(null)
      if (!commentResolutionLaunchAcceptedRef.current) {
        pendingCommentResolutionRef.current = null
        claimedCommentResolutionRef.current = null
        clearPendingPRCommentAiAck()
      }
    }
  }, [
    agentComposerState?.commentResolution,
    stateRequestKey,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    setAgentComposerState,
    commentResolutionLaunchAcceptedRef
  ])
  return {
    prAiGenerationEnabled,
    prBase,
    setPrBase,
    prTitle,
    setPrTitle,
    prBody,
    setPrBody,
    prDraft,
    setPrDraft,
    prStackedCreationSupported,
    prRepoDefaultBaseRef,
    prBaseQuery,
    setPrBaseQuery,
    prBaseResults,
    setPrBaseResults,
    prBaseSearchPending,
    prBaseSearchError,
    prGenerating,
    prGenerateError,
    prGenerateDisabled,
    prGenerateDisabledReason,
    handleGeneratePullRequestFields,
    handleCancelGeneratePullRequestFields,
    applyGeneratedPullRequestFields,
    pullRequestFieldsInitialized,
    stackParentReview,
    handlePrBaseChange,
    handlePrTitleChange,
    stateRequestKey,
    isCurrentAsyncResult
  }
}

export type ChecksPanelComposerState = ReturnType<typeof useChecksPanelComposerState>
