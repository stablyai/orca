import { CreateHostedReviewComposer } from '../../CreateHostedReviewComposer'
import { CommitArea } from '../commit/commit-area'
import { writeCommitDraftForWorktree } from '../commit/commit-drafts'
import type { SourceControlPanelReadyProps } from './panel-props'

type SourceControlCommitSurfaceProps = SourceControlPanelReadyProps & {
  showGenericEmptyState: boolean
}

/**
 * The one action surface below the file list: the review composer when Create review is the direct
 * next step, otherwise the commit box.
 */
export function SourceControlCommitSurface({
  activeRepo,
  model,
  showGenericEmptyState,
  worktreePath
}: SourceControlCommitSurfaceProps) {
  const {
    activeConnectionId,
    activeGroupId,
    activeSourceControlLaunchPlatform,
    activeWorktreeId,
    branchName,
    commitError,
    commitFailureRecoveryPrompt,
    commitMessage,
    createPrIntentNotice,
    directCreatePrAction,
    dropdownItems,
    generateError,
    getLaunchActionRecipe,
    grouped,
    handleActionInvoke,
    handleCancelGenerate,
    handleCancelGeneratePullRequestFields,
    handleCreatePullRequest,
    handleFixCommitFailureWithAI,
    handleFixPushFailureWithAI,
    handleGenerateCommitMessageClick,
    handleGeneratePullRequestFieldsClick,
    handlePrimaryClick,
    hasPartiallyStagedChanges,
    hostedReviewCreateProvider,
    inFlightRemoteOpKind,
    isAbortingOperation,
    isCommitting,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isGenerating,
    isLaunchingCommitFailureAgent,
    isLaunchingPushFailureAgent,
    isRemoteOperationActive,
    openSourceControlAiSettings,
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
    primaryAction,
    pushRecovery,
    remoteActionError,
    resolvedCommitMessageAi,
    saveLaunchActionDefault,
    setPrBase,
    setPrBaseQuery,
    setPrBaseResults,
    setPrBody,
    setPrDraft,
    setPrTitle,
    sourceControlAiActionsVisible,
    stackParentReview,
    unresolvedConflicts,
    updateCommitDrafts
  } = model

  if (directCreatePrAction) {
    return (
      <CreateHostedReviewComposer
        key={`${activeRepo.id}:${activeWorktreeId ?? worktreePath}:${branchName}`}
        provider={hostedReviewCreateProvider}
        branch={branchName}
        base={prBase}
        repoDefaultBase={prRepoDefaultBaseRef}
        setBase={setPrBase}
        title={prTitle}
        setTitle={setPrTitle}
        body={prBody}
        setBody={setPrBody}
        draft={prDraft}
        setDraft={setPrDraft}
        stackedCreationSupported={prStackedCreationSupported}
        stackParentReview={stackParentReview}
        baseQuery={prBaseQuery}
        setBaseQuery={setPrBaseQuery}
        baseResults={prBaseResults}
        setBaseResults={setPrBaseResults}
        baseSearchPending={prBaseSearchPending}
        baseSearchError={prBaseSearchError}
        aiGenerationEnabled={sourceControlAiActionsVisible && prAiGenerationEnabled}
        generating={prGenerating}
        generateDisabled={prGenerateDisabled}
        generateDisabledReason={prGenerateDisabledReason}
        generateError={prGenerateError}
        createError={
          createPrIntentNotice?.tone === 'destructive' ? createPrIntentNotice.message : null
        }
        isCreating={isCreatingPr}
        primaryAction={directCreatePrAction}
        dropdownItems={dropdownItems}
        onGenerate={handleGeneratePullRequestFieldsClick}
        onCancelGenerate={handleCancelGeneratePullRequestFields}
        onPrimaryAction={(stacked) => {
          void handleCreatePullRequest(stacked)
        }}
        onDropdownAction={handleActionInvoke}
      />
    )
  }

  return (
    <CommitArea
      worktreeId={activeWorktreeId}
      connectionId={activeConnectionId}
      repoId={activeRepo.id}
      launchPlatform={activeSourceControlLaunchPlatform}
      commitMessage={commitMessage}
      commitError={commitError}
      commitFailureRecoveryPrompt={commitFailureRecoveryPrompt}
      pushRecovery={pushRecovery}
      remoteActionError={pushRecovery ? null : (remoteActionError?.message ?? null)}
      createPrIntentNotice={createPrIntentNotice}
      isCommitting={isCommitting}
      isFixingCommitFailureWithAI={isLaunchingCommitFailureAgent}
      isFixingPushFailureWithAI={isLaunchingPushFailureAgent}
      isCreatingPr={isCreatingPr || isCreatePrIntentInFlight}
      isCreatePrIntentInFlight={isCreatePrIntentInFlight}
      groupId={activeGroupId ?? activeWorktreeId}
      showComposer={!showGenericEmptyState}
      sourceControlAiActionsVisible={sourceControlAiActionsVisible}
      aiAgentConfigured={resolvedCommitMessageAi?.ok === true}
      isGenerating={isGenerating}
      generateError={generateError}
      stagedCount={grouped.staged.length}
      hasPartiallyStagedChanges={hasPartiallyStagedChanges}
      hasUnresolvedConflicts={unresolvedConflicts.length > 0}
      isRemoteOperationActive={isRemoteOperationActive || isAbortingOperation}
      inFlightRemoteOpKind={inFlightRemoteOpKind}
      primaryAction={primaryAction}
      dropdownItems={dropdownItems}
      fixCommitFailureRecipe={getLaunchActionRecipe('fixCommitFailure')}
      fixPushFailureRecipe={getLaunchActionRecipe('fixPushFailure')}
      onCommitMessageChange={(value) => {
        if (!activeWorktreeId) {
          return
        }
        updateCommitDrafts((prev) => writeCommitDraftForWorktree(prev, activeWorktreeId, value))
      }}
      onGenerate={handleGenerateCommitMessageClick}
      onCancelGenerate={handleCancelGenerate}
      onSaveLaunchActionDefault={saveLaunchActionDefault}
      onOpenSourceControlAiSettings={openSourceControlAiSettings}
      onFixCommitFailureWithAI={handleFixCommitFailureWithAI}
      onFixPushFailureWithAI={handleFixPushFailureWithAI}
      onPrimaryAction={handlePrimaryClick}
      onDropdownAction={handleActionInvoke}
    />
  )
}
