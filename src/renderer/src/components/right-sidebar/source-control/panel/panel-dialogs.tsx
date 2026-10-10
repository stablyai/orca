import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readSourceControlLaunchRecipeAgentId } from '../../../../../../shared/source-control-launch-agent-selection'
import {
  planSourceControlCompareBaseRefWrite,
  type SourceControlCompareBaseRefWrite
} from './compare-base-ref-write'
import { SourceControlDialogLayer } from './dialog-layer'
import type { SourceControlPanelReadyProps } from './panel-props'

/** Every modal the panel can raise, kept outside the scrolling surface so none of them clip. */
export function SourceControlPanelDialogs({
  activeRepo,
  activeWorktree,
  model
}: SourceControlPanelReadyProps) {
  const {
    activeConnectionId,
    activeGroupId,
    activeSourceControlLaunchPlatform,
    activeWorktreeId,
    baseRefDialogOpen,
    baseRefOwnedByWorktree,
    cancelPendingDiscard,
    commitGenerationDialogOpen,
    confirmPendingDiscard,
    getLaunchActionRecipe,
    handleConfirmDiffCommentsClear,
    handleGenerate,
    handleGeneratePullRequestFields,
    handleSaveCommitMessageGenerationDefaults,
    handleSavePullRequestGenerationDefaults,
    isClearingDiffComments,
    openSourceControlAiSettings,
    pendingDiffCommentsClearCount,
    pendingDiffCommentsClearDescription,
    pendingDiscard,
    pickerBaseRef,
    pullRequestGenerationDialogOpen,
    refreshBranchCompare,
    resolveConflictsComposerOpen,
    resolveConflictsPrompt,
    resolvedPendingDiffCommentsClear,
    saveLaunchActionDefault,
    setBaseRefDialogOpen,
    setCommitGenerationDialogOpen,
    setPendingDiffCommentsClear,
    setPullRequestGenerationDialogOpen,
    setResolveConflictsComposerOpen,
    settings,
    sourceControlAiActionsVisible,
    sourceControlAiDiscoveryHostKey,
    updateRepo,
    updateWorktreeMeta
  } = model

  const closeAndRefreshCompare = (): void => {
    setBaseRefDialogOpen(false)
    window.setTimeout(() => void refreshBranchCompare(), 0)
  }

  const applyCompareBaseRefWrite = (write: SourceControlCompareBaseRefWrite): boolean => {
    if (!write.worktreeUpdate) {
      return false
    }
    void updateWorktreeMeta(write.worktreeUpdate.worktreeId, {
      baseRef: write.worktreeUpdate.baseRef
    })
    return true
  }

  // Why awaited: the project pin is shared by every workspace, so success must not be claimed before the write lands.
  const applyProjectBaseRefWrite = async (
    write: SourceControlCompareBaseRefWrite,
    successMessage: string | null
  ): Promise<void> => {
    if (!write.repoUpdate) {
      return
    }
    const saved = await updateRepo(write.repoUpdate.repoId, {
      worktreeBaseRef: write.repoUpdate.worktreeBaseRef
    })
    if (!saved) {
      toast.error(
        translate(
          'auto.components.right.sidebar.SourceControl.e03eb08e1e',
          'Could not save the project default'
        )
      )
      return
    }
    if (successMessage) {
      toast.success(successMessage)
    }
    closeAndRefreshCompare()
  }

  const clearsProjectDefault =
    !baseRefOwnedByWorktree && Boolean(activeRepo.worktreeBaseRef?.trim())

  return (
    <SourceControlDialogLayer
      clearNotesOpen={resolvedPendingDiffCommentsClear !== null}
      clearNotesDescription={pendingDiffCommentsClearDescription}
      clearNotesCount={pendingDiffCommentsClearCount}
      isClearingNotes={isClearingDiffComments}
      onDismissClearNotes={() => setPendingDiffCommentsClear(null)}
      onConfirmClearNotes={() => void handleConfirmDiffCommentsClear()}
      pendingDiscard={pendingDiscard}
      onCancelDiscard={cancelPendingDiscard}
      onConfirmDiscard={confirmPendingDiscard}
      baseRefDialogOpen={baseRefDialogOpen}
      onBaseRefDialogOpenChange={setBaseRefDialogOpen}
      baseRefRepoId={activeRepo.id}
      pickerBaseRef={pickerBaseRef}
      onSelectBaseRef={(ref) => {
        if (
          !applyCompareBaseRefWrite(
            planSourceControlCompareBaseRefWrite({
              action: 'select',
              worktreeId: activeWorktreeId,
              ref
            })
          )
        ) {
          return
        }
        closeAndRefreshCompare()
      }}
      onUsePrimaryBaseRef={
        baseRefOwnedByWorktree
          ? () => {
              if (
                applyCompareBaseRefWrite(
                  planSourceControlCompareBaseRefWrite({
                    action: 'use-project-default',
                    worktreeId: activeWorktreeId
                  })
                )
              ) {
                closeAndRefreshCompare()
              }
            }
          : clearsProjectDefault
            ? () =>
                void applyProjectBaseRefWrite(
                  planSourceControlCompareBaseRefWrite({
                    action: 'clear-project-default',
                    repoId: activeRepo.id
                  }),
                  null
                )
            : undefined
      }
      usePrimaryBaseRefLabel={
        baseRefOwnedByWorktree
          ? translate(
              'auto.components.right.sidebar.SourceControl.3138a3323d',
              'Use project default'
            )
          : undefined
      }
      onSetAsProjectDefault={() =>
        void applyProjectBaseRefWrite(
          planSourceControlCompareBaseRefWrite({
            action: 'set-project-default',
            repoId: activeRepo.id,
            ref: pickerBaseRef
          }),
          translate(
            'auto.components.right.sidebar.SourceControl.032b4cd034',
            'Saved as project default'
          )
        )
      }
      sourceControlAiActionsVisible={sourceControlAiActionsVisible}
      resolveConflictsComposerOpen={resolveConflictsComposerOpen}
      onResolveConflictsComposerOpenChange={setResolveConflictsComposerOpen}
      resolveConflictsPrompt={resolveConflictsPrompt}
      worktreeId={activeWorktreeId}
      groupId={activeGroupId ?? activeWorktreeId}
      connectionId={activeConnectionId}
      repoId={activeRepo.id}
      launchPlatform={activeSourceControlLaunchPlatform}
      savedResolveConflictsAgentId={readSourceControlLaunchRecipeAgentId(
        getLaunchActionRecipe('resolveConflicts')
      )}
      savedResolveConflictsCommandInputTemplate={
        getLaunchActionRecipe('resolveConflicts').commandInputTemplate ?? null
      }
      savedResolveConflictsAgentArgs={getLaunchActionRecipe('resolveConflicts').agentArgs ?? null}
      onSaveAgentDefault={saveLaunchActionDefault}
      onOpenSourceControlAiSettings={openSourceControlAiSettings}
      commitGenerationDialogOpen={commitGenerationDialogOpen}
      onCommitGenerationDialogOpenChange={setCommitGenerationDialogOpen}
      pullRequestGenerationDialogOpen={pullRequestGenerationDialogOpen}
      onPullRequestGenerationDialogOpenChange={setPullRequestGenerationDialogOpen}
      settings={settings}
      repo={activeRepo}
      discoveryHostKey={sourceControlAiDiscoveryHostKey}
      linkedIssue={activeWorktree.linkedIssue ?? null}
      onGenerateCommitMessage={(params) => {
        void handleGenerate({ sourceControlAiResolvedParams: params })
      }}
      onSaveCommitMessageDefaults={handleSaveCommitMessageGenerationDefaults}
      onGeneratePullRequestFields={(params) => {
        void handleGeneratePullRequestFields({ sourceControlAiResolvedParams: params })
      }}
      onSavePullRequestDefaults={handleSavePullRequestGenerationDefaults}
    />
  )
}
