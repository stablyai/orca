import { toast } from 'sonner'
import { readSourceControlLaunchRecipeAgentId } from '../../../../../../shared/source-control-launch-agent-selection'
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

  const writeWorktreeBaseRef = async (worktreeId: string, baseRef: string | undefined) => {
    const result = await updateWorktreeMeta(worktreeId, { baseRef })
    // Why: a failed write is reverted by a refetch, so without this the pick silently undoes itself.
    if (!result.ok) {
      toast.error(result.error)
    }
  }

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
        // Why: a repo-wide write here retargeted every sibling worktree without its own pin; the repo default lives in project settings.
        if (activeWorktreeId) {
          void writeWorktreeBaseRef(activeWorktreeId, ref)
        } else {
          void updateRepo(activeRepo.id, { worktreeBaseRef: ref })
        }
        setBaseRefDialogOpen(false)
        window.setTimeout(() => void refreshBranchCompare(), 0)
      }}
      onUsePrimaryBaseRef={
        baseRefOwnedByWorktree && activeWorktreeId
          ? () => {
              void writeWorktreeBaseRef(activeWorktreeId, undefined)
              setBaseRefDialogOpen(false)
              window.setTimeout(() => void refreshBranchCompare(), 0)
            }
          : undefined
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
