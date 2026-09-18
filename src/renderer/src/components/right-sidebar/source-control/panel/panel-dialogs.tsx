import { readSourceControlLaunchRecipeAgentId } from '@/lib/source-control-launch-agent-selection'
import { SourceControlDialogLayer } from './dialog-layer'
import { SourceControlPanelNotesClearDialog } from './notes-clear-dialog'
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
    handleGenerate,
    handleGeneratePullRequestFields,
    handleSaveCommitMessageGenerationDefaults,
    handleSavePullRequestGenerationDefaults,
    openSourceControlAiSettings,
    pendingDiscard,
    pickerBaseRef,
    pullRequestGenerationDialogOpen,
    refreshBranchCompare,
    resolveConflictsComposerOpen,
    resolveConflictsPrompt,
    saveLaunchActionDefault,
    setBaseRefDialogOpen,
    setCommitGenerationDialogOpen,
    setPullRequestGenerationDialogOpen,
    setResolveConflictsComposerOpen,
    settings,
    sourceControlAiActionsVisible,
    sourceControlAiDiscoveryHostKey,
    updateRepo,
    updateWorktreeMeta
  } = model

  return (
    <>
      <SourceControlPanelNotesClearDialog model={model} />
      <SourceControlDialogLayer
        pendingDiscard={pendingDiscard}
        onCancelDiscard={cancelPendingDiscard}
        onConfirmDiscard={confirmPendingDiscard}
        baseRefDialogOpen={baseRefDialogOpen}
        onBaseRefDialogOpenChange={setBaseRefDialogOpen}
        baseRefRepoId={activeRepo.id}
        pickerBaseRef={pickerBaseRef}
        onSelectBaseRef={(ref) => {
          if (baseRefOwnedByWorktree && activeWorktreeId) {
            void updateWorktreeMeta(activeWorktreeId, { baseRef: ref })
          } else {
            void updateRepo(activeRepo.id, { worktreeBaseRef: ref })
          }
          setBaseRefDialogOpen(false)
          window.setTimeout(() => void refreshBranchCompare(), 0)
        }}
        onUsePrimaryBaseRef={() => {
          if (baseRefOwnedByWorktree && activeWorktreeId) {
            void updateWorktreeMeta(activeWorktreeId, { baseRef: undefined })
          } else {
            void updateRepo(activeRepo.id, { worktreeBaseRef: undefined })
          }
          setBaseRefDialogOpen(false)
          window.setTimeout(() => void refreshBranchCompare(), 0)
        }}
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
    </>
  )
}
