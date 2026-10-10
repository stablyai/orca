import type { ComposerTargetState } from './composer-target-state-contract'
import { resolveComposerAttachmentTarget } from './composer-attachment-target'
import { useAttachmentDropState } from './attachment-drop-state'

export function useComposerAttachmentDropState(target: ComposerTargetState) {
  const destination = resolveComposerAttachmentTarget({
    selectedProjectGroup: target.initialTargetState.selectedProjectGroup,
    selectedRepoPath: target.asyncComposerState.selectedRepoPath,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoSettings: target.runtimeTargetSelection.selectedRepoSettings,
    connectionId: target.workspaceIdentityState.connectionId
  })
  return useAttachmentDropState({
    agentPromptRef: target.asyncComposerState.agentPromptRef,
    cancelPromptCaretFrame: target.providerRuntimeSync.cancelPromptCaretFrame,
    connectionId: destination.connectionId,
    promptCaretFrameRef: target.asyncComposerState.promptCaretFrameRef,
    promptTextareaRef: target.asyncComposerState.promptTextareaRef,
    selectedRepoPath: destination.path ?? undefined,
    selectedRepoSettings: destination.settings,
    selectedWorktreeId: destination.worktreeId,
    setAgentPrompt: target.sourceContextState.setAgentPrompt,
    setAttachmentPaths: target.sourceContextState.setAttachmentPaths
  })
}
