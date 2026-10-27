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

export function useSourceControlCreateReviewComposer({
  activePullRequestGenerationKey,
  activePullRequestGenerationRecord,
  activePullRequestGenerationSeedRestoreKey,
  activeRepo,
  activeRepoTarget,
  activeWorktreeId,
  activeWorktree,
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
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  activeWorktree?: SourceControlWorktreeContext['activeWorktree']
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
    fieldRevisions: prFieldRevisions,
    fieldsAreSeedPlaceholders: prFieldsAreSeedPlaceholders,
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
    workspace: activeWorktree,
    eligibility: hostedReviewCreation,
    currentBaseRef: effectiveBaseRef,
    repo: activeRepo ?? null,
    settings,
    target: activeRepoTarget,
    submitting: isCreatingPr,
    prCreationDefaults: resolvedPrCreationDefaults,
    sourceControlAiActionsVisible,
    onBranchChangedByGeneration: handleBranchChangedByPullRequestGeneration,
    generation: {
      generating: activePullRequestGenerationRecord?.status === 'running',
      generateError: activePullRequestGenerationRecord?.error ?? null,
      seedRestoreKey: activePullRequestGenerationSeedRestoreKey,
      seed:
        activePullRequestGenerationRecord?.editedFields?.fields ??
        activePullRequestGenerationRecord?.seed ??
        null,
      seedFieldRevisions:
        activePullRequestGenerationRecord?.editedFields?.revisions ??
        activePullRequestGenerationRecord?.seedFieldRevisions ??
        null,
      onSeedRestored: handlePullRequestGenerationSeedRestored,
      onGenerate: handleGeneratePullRequestFieldsForActive,
      onCancelGenerate: handleCancelGeneratePullRequestFieldsForActive
    }
  })
  const stackParentReview = useHostedReviewStackParent({
    enabled: hostedReviewCreateProvider === 'github' && prStackedCreationSupported,
    repoPath: activeRepo?.path ?? '',
    repoId: activeRepo?.id ?? null,
    base: prBase,
    // Use the repo default; eligibility’s defaultBaseRef may be the stacked PR’s own target.
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
    // Hydrate after the fields hook seeds defaults on remount, or those defaults overwrite generation.
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
    prFieldRevisions,
    prFieldsAreSeedPlaceholders,
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
