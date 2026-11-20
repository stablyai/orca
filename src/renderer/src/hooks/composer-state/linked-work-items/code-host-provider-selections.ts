import type { ComposerTargetState } from '../composer-target-state-contract'
import type { useBranchStartPointActions } from '../workspace-start-point/branch-start-point-actions'
import { useGiteaProviderSelection } from './gitea-provider-selection'
import { useGitLabProviderSelection } from './gitlab-provider-selection'
import type { useSourceIdentityActions } from './source-identity-actions'

export function useCodeHostProviderSelections(
  target: ComposerTargetState,
  sourceIdentityActions: ReturnType<typeof useSourceIdentityActions>,
  branchStartPointActions: ReturnType<typeof useBranchStartPointActions>
) {
  const providerSelectionInput = {
    smartSourceSelectionRef: target.asyncComposerState.smartSourceSelectionRef,
    applyLinkedGitLabWorkItem: sourceIdentityActions.applyLinkedGitLabWorkItem,
    branchAutoNameRef: target.asyncComposerState.branchAutoNameRef,
    eligibleRepos: target.composerTargetStore.eligibleRepos,
    handleBaseBranchMrSelect: branchStartPointActions.handleBaseBranchMrSelect,
    isProjectGroupTarget: target.runtimeTargetSelection.isProjectGroupTarget,
    lastAutoNameRef: target.asyncComposerState.lastAutoNameRef,
    linkedWorkItem: target.sourceContextState.linkedWorkItem,
    name: target.sourceContextState.name,
    selectedRepo: target.runtimeTargetSelection.selectedRepo,
    setBaseBranch: target.workspaceIdentityState.setBaseBranch,
    setBranchNameOverride: target.workspaceIdentityState.setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits:
      target.workspaceIdentityState.setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef: target.workspaceIdentityState.setCompareBaseRef,
    setForkPushWarning: target.workspaceIdentityState.setForkPushWarning,
    setLinkedGitLabIssue: target.workspaceIdentityState.setLinkedGitLabIssue,
    setLinkedGitLabMR: target.workspaceIdentityState.setLinkedGitLabMR,
    clearLinkedGiteaItems: target.workspaceIdentityState.clearLinkedGiteaItems,
    setLinkedGiteaIssue: target.workspaceIdentityState.setLinkedGiteaIssue,
    setLinkedGiteaPR: target.workspaceIdentityState.setLinkedGiteaPR,
    setLinkedIssue: target.workspaceIdentityState.setLinkedIssue,
    setLinkedPR: target.workspaceIdentityState.setLinkedPR,
    setLinkedTaskSourceContext: target.sourceContextState.setLinkedTaskSourceContext,
    setLinkedWorkItem: target.sourceContextState.setLinkedWorkItem,
    setName: target.sourceContextState.setName,
    setPushTarget: target.workspaceIdentityState.setPushTarget,
    setStartFromResetHint: target.workspaceIdentityState.setStartFromResetHint
  }
  return {
    gitlabProviderSelection: useGitLabProviderSelection(providerSelectionInput),
    giteaProviderSelection: useGiteaProviderSelection(providerSelectionInput)
  }
}
