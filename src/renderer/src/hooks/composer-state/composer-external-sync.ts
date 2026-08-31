import type { ComposerTargetState } from './composer-target-state-contract'
import type { ComposerExternalSyncState } from './composer-external-sync-contract'
import { useHostRuntimeEffects } from './host-runtime-effects'
import { useLinkedItemLookupEffects } from './linked-item-lookup-effects'
import { useGitHubSourceApplication } from './github-source-application'
import { useGitHubSubmitResolution } from './github-submit-resolution'

export function useComposerExternalSync(target: ComposerTargetState): ComposerExternalSyncState {
  const hostRuntimeEffects = useHostRuntimeEffects({
    commitHookCheckIfCurrent: target.providerRuntimeSync.commitHookCheckIfCurrent,
    connectionId: target.workspaceIdentityState.connectionId,
    createGateMode: target.composerTargetStore.createGateMode,
    disabledTuiAgents: target.workspaceIdentityState.disabledTuiAgents,
    enableIssueAutomation: target.composerTargetStore.enableIssueAutomation,
    ensureDetectedAgents: target.workspaceIdentityState.ensureDetectedAgents,
    ensureRemoteDetectedAgents: target.workspaceIdentityState.ensureRemoteDetectedAgents,
    ensureRuntimeDetectedAgents: target.workspaceIdentityState.ensureRuntimeDetectedAgents,
    fallbackDefaultAgent: target.workspaceIdentityState.fallbackDefaultAgent,
    folderTargetConnectionId: target.runtimeTargetSelection.folderTargetConnectionId,
    isRemote: target.workspaceIdentityState.isRemote,
    loadHookCheckForRepo: target.providerRuntimeSync.loadHookCheckForRepo,
    newWorkspaceDraft: target.composerTargetStore.newWorkspaceDraft,
    repoId: target.initialTargetState.repoId,
    repoIdRef: target.runtimeTargetSelection.repoIdRef,
    runtimeEnvironmentId: target.workspaceIdentityState.runtimeEnvironmentId,
    selectedRepoConnectionIdRef: target.asyncComposerState.selectedRepoConnectionIdRef,
    selectedRepoExecutionHostId: target.runtimeTargetSelection.selectedRepoExecutionHostId,
    selectedRepoHookContextKey: target.runtimeTargetSelection.selectedRepoHookContextKey,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoSettingsRef: target.asyncComposerState.selectedRepoSettingsRef,
    selectedRepoSshStatus: target.runtimeTargetSelection.selectedRepoSshStatus,
    setLoadedIssueCommand: target.asyncComposerState.setLoadedIssueCommand,
    setTuiAgent: target.workspaceIdentityState.setTuiAgent,
    settings: target.composerTargetStore.settings,
    tuiAgent: target.workspaceIdentityState.tuiAgent
  })
  const linkedItemLookupEffects = useLinkedItemLookupEffects({
    baseBranch: target.workspaceIdentityState.baseBranch,
    linkPopoverOpen: target.asyncComposerState.linkPopoverOpen,
    linkQuery: target.asyncComposerState.linkQuery,
    normalizedLinkQuery: target.derivedComposerState.normalizedLinkQuery,
    prefetchWorkItems: target.composerTargetStore.prefetchWorkItems,
    prefetchWorktreeCreateBase: target.composerTargetStore.prefetchWorktreeCreateBase,
    repoId: target.initialTargetState.repoId,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoConnectionId: target.runtimeTargetSelection.selectedRepoConnectionId,
    selectedRepoGitHubSourceContext: target.sourceContextState.selectedRepoGitHubSourceContext,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    selectedRepoSshStatus: target.runtimeTargetSelection.selectedRepoSshStatus,
    setLinkDebouncedQuery: target.asyncComposerState.setLinkDebouncedQuery,
    setLinkDirectItem: target.asyncComposerState.setLinkDirectItem,
    setLinkDirectLoading: target.asyncComposerState.setLinkDirectLoading,
    setLinkItems: target.asyncComposerState.setLinkItems,
    setLinkItemsLoading: target.asyncComposerState.setLinkItemsLoading,
    setSetupDecision: target.asyncComposerState.setSetupDecision,
    setupConfig: target.derivedComposerState.setupConfig,
    setupPolicy: target.derivedComposerState.setupPolicy,
    shouldWaitForSetupCheck: target.derivedComposerState.shouldWaitForSetupCheck,
    sshConnectedGeneration: target.composerTargetStore.sshConnectedGeneration
  })
  const githubSourceApplication = useGitHubSourceApplication({
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    name: target.sourceContextState.name,
    selectedRepoGitHubSourceContext: target.sourceContextState.selectedRepoGitHubSourceContext,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setName: target.sourceContextState.setName
  })
  const githubSubmitResolution = useGitHubSubmitResolution({
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    folderSourceRepos: target.runtimeTargetSelection.folderSourceRepos,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    selectedRepoGitHubSourceContext: target.sourceContextState.selectedRepoGitHubSourceContext,
    selectedRepoIsGit: target.runtimeTargetSelection.selectedRepoIsGit,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setName: target.sourceContextState.setName,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint,
    settings: target.composerTargetStore.settings,
    smartGitHubPrStartPointSelectionRef:
      target.asyncComposerState.smartGitHubPrStartPointSelectionRef
  })
  return {
    hostRuntimeEffects,
    linkedItemLookupEffects,
    githubSourceApplication,
    githubSubmitResolution
  }
}
