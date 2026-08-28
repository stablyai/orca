import { useCallback, useEffect } from 'react'
import { shouldHydratePullRequestGenerationResult } from '@/store/slices/pull-request-generation'
import { hasConfiguredSourceControlTextGenerationDefaults } from '../ai/text-generation-defaults'
import type { SourceControlAi } from '../ai/use-ai'
import { useCreatePullRequestDialogFields } from '../../useCreatePullRequestDialogFields'
import { useHostedReviewStackParent } from '../../useHostedReviewStackParent'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import type { SourceControlPullRequestGeneration } from './use-pull-request-generation'

/**
 * Owns the Create-review composer fields (base/title/body/draft, stack parent) and folds a finished
 * background generation back into them once the fields hook has seeded eligibility defaults.
 */
export function useSourceControlCreateReviewComposer({
  activePullRequestGenerationKey,
  activePullRequestGenerationRecord,
  activePullRequestGenerationSeedRestoreKey,
  activeRepo,
  activeRepoSettings,
  activeWorktreeId,
  branchName,
  effectiveBaseRef,
  fetchHostedReviewForBranch,
  handleBranchChangedByPullRequestGeneration,
  handleCancelGeneratePullRequestFieldsForActive,
  handleGeneratePullRequestFieldsForActive,
  handlePullRequestGenerationSeedRestored,
  hostedReviewCreateProvider,
  hostedReviewCreation,
  isCreatingPr,
  openPullRequestGenerationDialog,
  resolvedPrCreationDefaults,
  settings,
  sourceControlAiActionsVisible,
  updatePullRequestGenerationRecord,
  worktreePath
}: {
  activePullRequestGenerationKey: SourceControlPullRequestGeneration['activePullRequestGenerationKey']
  activePullRequestGenerationRecord: SourceControlPullRequestGeneration['activePullRequestGenerationRecord']
  activePullRequestGenerationSeedRestoreKey: SourceControlPullRequestGeneration['activePullRequestGenerationSeedRestoreKey']
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktreeId: string | null
  branchName: string
  effectiveBaseRef: string | null
  fetchHostedReviewForBranch: SourceControlStoreActions['fetchHostedReviewForBranch']
  handleBranchChangedByPullRequestGeneration: () => Promise<void>
  handleCancelGeneratePullRequestFieldsForActive: SourceControlPullRequestGeneration['handleCancelGeneratePullRequestFieldsForActive']
  handleGeneratePullRequestFieldsForActive: SourceControlPullRequestGeneration['handleGeneratePullRequestFieldsForActive']
  handlePullRequestGenerationSeedRestored: SourceControlPullRequestGeneration['handlePullRequestGenerationSeedRestored']
  hostedReviewCreateProvider: SourceControlHostedReviewState['hostedReviewCreateProvider']
  hostedReviewCreation: SourceControlHostedReviewState['hostedReviewCreation']
  isCreatingPr: boolean
  openPullRequestGenerationDialog: SourceControlAi['openPullRequestGenerationDialog']
  resolvedPrCreationDefaults: SourceControlAi['resolvedPrCreationDefaults']
  settings: SourceControlWorktreeContext['settings']
  sourceControlAiActionsVisible: boolean
  updatePullRequestGenerationRecord: SourceControlStoreActions['updatePullRequestGenerationRecord']
  worktreePath: string | null
}) {
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
    open: hostedReviewCreation?.canCreate === true,
    repoId: activeRepo?.id ?? '',
    worktreeId: activeWorktreeId,
    worktreePath: worktreePath ?? '',
    branch: branchName,
    eligibility: hostedReviewCreation,
    currentBaseRef: effectiveBaseRef,
    repo: activeRepo ?? null,
    settings: activeRepoSettings,
    submitting: isCreatingPr,
    prCreationDefaults: resolvedPrCreationDefaults,
    sourceControlAiActionsVisible,
    onBranchChangedByGeneration: handleBranchChangedByPullRequestGeneration,
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
    repoPath: activeRepo?.path ?? '',
    repoId: activeRepo?.id ?? null,
    base: prBase,
    // Why: the repo default, not eligibility's defaultBaseRef — that one resolves to
    // the worktree's own base, which is exactly the branch a stacked PR targets.
    repoDefaultBase: prRepoDefaultBaseRef,
    head: branchName,
    fetchHostedReviewForBranch
  })

  const handleGeneratePullRequestFieldsClick = useCallback((): void => {
    if (!sourceControlAiActionsVisible) {
      return
    }
    if (
      hasConfiguredSourceControlTextGenerationDefaults({
        actionId: 'pullRequest',
        settings,
        repo: activeRepo ?? null
      })
    ) {
      void handleGeneratePullRequestFields()
      return
    }
    openPullRequestGenerationDialog()
  }, [
    activeRepo,
    handleGeneratePullRequestFields,
    openPullRequestGenerationDialog,
    settings,
    sourceControlAiActionsVisible
  ])

  useEffect(() => {
    // Why: on remount the PR fields hook seeds eligibility defaults in an effect; hydrating before it runs gets overwritten.
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
    const result = activePullRequestGenerationRecord.result
    applyGeneratedPullRequestFields(result, activePullRequestGenerationRecord.seedFieldRevisions)
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

  return {
    applyGeneratedPullRequestFields,
    handleCancelGeneratePullRequestFields,
    handleGeneratePullRequestFields,
    handleGeneratePullRequestFieldsClick,
    prAiGenerationEnabled,
    prBase,
    prBaseQuery,
    prBaseResults,
    prBaseSearchError,
    prBaseSearchPending,
    prBody,
    prDraft,
    prGenerateDisabled,
    prGenerateDisabledReason,
    prGenerateError,
    prGenerating,
    prRepoDefaultBaseRef,
    prStackedCreationSupported,
    prTitle,
    pullRequestFieldsInitialized,
    setPrBase,
    setPrBaseQuery,
    setPrBaseResults,
    setPrBody,
    setPrDraft,
    setPrTitle,
    stackParentReview
  }
}

export type SourceControlCreateReviewComposer = ReturnType<
  typeof useSourceControlCreateReviewComposer
>
