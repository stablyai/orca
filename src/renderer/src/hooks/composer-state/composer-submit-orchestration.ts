import type { ComposerTargetState } from './composer-target-state-contract'
import type { ComposerExternalSyncState } from './composer-external-sync-contract'
import type { ComposerSourceState } from './composer-source-state-contract'
import type { ComposerSubmitState } from './composer-submit-state-contract'
import { useFolderSubmitOrchestration } from './folder-submit-orchestration'
import { useMultipleCreateReset } from './multiple-create-reset'
import { useQuickSubmitSourcePreparation } from './quick-submit-source-preparation'
import { useQuickSubmitPreparation } from './quick-submit-preparation'
import { useQuickCreationExecution } from './quick-creation-execution'
import { useQuickSubmitAction } from './quick-submit-action'

export function useComposerSubmitOrchestration(
  target: ComposerTargetState,
  external: ComposerExternalSyncState,
  source: ComposerSourceState
): ComposerSubmitState {
  const folderSubmitOrchestration = useFolderSubmitOrchestration({
    clearNewWorkspaceDraft: target.composerTargetStore.clearNewWorkspaceDraft,
    createFolderWorkspace: target.composerTargetStore.createFolderWorkspace,
    decisions: target.composerTargetStore.decisions,
    disabledTuiAgents: target.workspaceIdentityState.disabledTuiAgents,
    folderCreateDisabled: source.composerNavigationActions.folderCreateDisabled,
    folderSourceRepos: target.runtimeTargetSelection.folderSourceRepos,
    folderTargetConnectionId: target.runtimeTargetSelection.folderTargetConnectionId,
    folderTargetIsRemote: target.runtimeTargetSelection.folderTargetIsRemote,
    folderTargetRuntimeEnvironmentId:
      target.runtimeTargetSelection.folderTargetRuntimeEnvironmentId,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    note: target.sourceContextState.note,
    onCreated: target.composerTargetStore.onCreated,
    persistDraft: target.composerTargetStore.persistDraft,
    resolvePendingSmartGitHubSubmit:
      external.githubSubmitResolution.resolvePendingSmartGitHubSubmit,
    selectedProjectGroup: target.initialTargetState.selectedProjectGroup,
    setCreateError: target.asyncComposerState.setCreateError,
    setCreating: target.asyncComposerState.setCreating,
    settings: target.composerTargetStore.settings,
    taskSourceContext: target.sourceContextState.taskSourceContext,
    telemetrySource: target.composerTargetStore.telemetrySource
  })
  const multipleCreateReset = useMultipleCreateReset({
    handleClearSmartNameSelection: source.issueSourceActions.handleClearSmartNameSelection,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    nameInputRef: target.asyncComposerState.nameInputRef,
    setAgentPrompt: target.sourceContextState.setAgentPrompt,
    setAttachmentPaths: target.sourceContextState.setAttachmentPaths,
    setCreateError: target.asyncComposerState.setCreateError,
    setName: target.sourceContextState.setName,
    setNote: target.sourceContextState.setNote
  })
  const quickSubmitSourcePreparation = useQuickSubmitSourcePreparation({
    baseBranch: target.workspaceIdentityState.baseBranch,
    branchNameOverride: target.workspaceIdentityState.branchNameOverride,
    compareBaseRef: target.workspaceIdentityState.compareBaseRef,
    disabledTuiAgents: target.workspaceIdentityState.disabledTuiAgents,
    effectiveLinkedPR: target.derivedComposerState.effectiveLinkedPR,
    decisions: target.composerTargetStore.decisions,
    fallbackCreatureName: target.derivedComposerState.fallbackCreatureName,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedGitLabMR: target.workspaceIdentityState.linkedGitLabMR,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    parsedLinkedIssueNumber: target.derivedComposerState.parsedLinkedIssueNumber,
    pushTarget: target.workspaceIdentityState.pushTarget
  })
  const quickSubmitPreparation = useQuickSubmitPreparation({
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    branchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.branchNameOverridePreservesNameEdits,
    checkedHooksContextKey: target.asyncComposerState.checkedHooksContextKey,
    commitHookCheckIfCurrent: target.providerRuntimeSync.commitHookCheckIfCurrent,
    enableIssueAutomation: target.composerTargetStore.enableIssueAutomation,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    loadHookCheckForRepo: target.providerRuntimeSync.loadHookCheckForRepo,
    name: target.sourceContextState.name,
    note: target.sourceContextState.note,
    prepareQuickSubmitSource: quickSubmitSourcePreparation.prepareQuickSubmitSource,
    repoId: target.initialTargetState.repoId,
    resolvedSetupDecision: target.derivedComposerState.resolvedSetupDecision,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoHookContextKey: target.runtimeTargetSelection.selectedRepoHookContextKey,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    setAdvancedOpen: target.asyncComposerState.setAdvancedOpen,
    settings: target.composerTargetStore.settings,
    setupConfig: target.derivedComposerState.setupConfig,
    setupDecision: target.asyncComposerState.setupDecision,
    setupPolicy: target.derivedComposerState.setupPolicy,
    smartNameMode: target.workspaceIdentityState.smartNameMode
  })
  const quickCreationExecution = useQuickCreationExecution({
    clearNewWorkspaceDraft: target.composerTargetStore.clearNewWorkspaceDraft,
    createMultiple: target.asyncComposerState.createMultiple,
    effectivePresetId: target.derivedComposerState.effectivePresetId,
    ephemeralVmRecipes: target.runtimeTargetSelection.ephemeralVmRecipes,
    ephemeralVmsEnabled: target.runtimeTargetSelection.ephemeralVmsEnabled,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    linkedGitLabIssue: target.workspaceIdentityState.linkedGitLabIssue,
    linkedGitLabMR: target.workspaceIdentityState.linkedGitLabMR,
    normalizedSparseDirectories: target.derivedComposerState.normalizedSparseDirectories,
    onCreated: target.composerTargetStore.onCreated,
    parentWorktreeId: target.workspaceIdentityState.parentWorktreeId,
    persistDraft: target.composerTargetStore.persistDraft,
    persistSetupAgentStartupPolicy: target.providerRuntimeSync.persistSetupAgentStartupPolicy,
    prepareQuickSubmit: quickSubmitPreparation.prepareQuickSubmit,
    resetForNextCreate: multipleCreateReset.resetForNextCreate,
    resolvedInitialWorkspaceStatus: target.initialTargetState.resolvedInitialWorkspaceStatus,
    selectedEphemeralVmRecipeId: target.runtimeTargetSelection.selectedEphemeralVmRecipeId,
    selectedRepoAgentLaunchPlatform: target.runtimeTargetSelection.selectedRepoAgentLaunchPlatform,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoIsRemote: target.runtimeTargetSelection.selectedRepoIsRemote,
    selectedRepoSettings: target.runtimeTargetSelection.selectedRepoSettings,
    selectedRepoStartupShell: target.runtimeTargetSelection.selectedRepoStartupShell,
    selectedWorkspaceTarget: target.runtimeTargetSelection.selectedWorkspaceTarget,
    settings: target.composerTargetStore.settings,
    sparseEnabled: target.asyncComposerState.sparseEnabled,
    taskSourceContext: target.sourceContextState.taskSourceContext,
    telemetrySource: target.composerTargetStore.telemetrySource
  })
  const quickSubmitAction = useQuickSubmitAction({
    effectiveLinkedPR: target.derivedComposerState.effectiveLinkedPR,
    executeQuickCreation: quickCreationExecution.executeQuickCreation,
    fallbackCreatureName: target.derivedComposerState.fallbackCreatureName,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    isSubmissionCancelled: target.composerTargetStore.isSubmissionCancelled,
    linkedPR: target.workspaceIdentityState.linkedPR,
    name: target.sourceContextState.name,
    onCreated: target.composerTargetStore.onCreated,
    parsedLinkedIssueNumber: target.derivedComposerState.parsedLinkedIssueNumber,
    repoId: target.initialTargetState.repoId,
    requiresExplicitSetupChoice: target.derivedComposerState.requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit:
      external.githubSubmitResolution.resolvePendingSmartGitHubSubmit,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoRequiresConnection: target.runtimeTargetSelection.selectedRepoRequiresConnection,
    selectedWorkspaceTarget: target.runtimeTargetSelection.selectedWorkspaceTarget,
    setCreateError: target.asyncComposerState.setCreateError,
    setCreating: target.asyncComposerState.setCreating,
    setupDecision: target.asyncComposerState.setupDecision,
    showProjectRequiredError: source.branchStartPointActions.showProjectRequiredError,
    sourceIntentBlocksCreate: target.workspaceIdentityState.sourceIntentBlocksCreate,
    sparseError: target.derivedComposerState.sparseError,
    submitFolderTarget: folderSubmitOrchestration.submitFolderTarget
  })
  return {
    folderSubmitOrchestration,
    multipleCreateReset,
    quickSubmitSourcePreparation,
    quickSubmitPreparation,
    quickCreationExecution,
    quickSubmitAction
  }
}
