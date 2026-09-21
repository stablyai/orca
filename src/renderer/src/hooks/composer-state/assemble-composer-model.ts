import type { ComposerModel } from './composer-model'
import type { ComposerTargetState } from './composer-target-state-contract'
import type { ComposerExternalSyncState } from './composer-external-sync-contract'
import type { ComposerSourceState } from './composer-source-state-contract'
import type { ComposerSubmitState } from './composer-submit-state-contract'

export function assembleComposerModel(
  target: ComposerTargetState,
  external: ComposerExternalSyncState,
  source: ComposerSourceState,
  submit: ComposerSubmitState
): ComposerModel {
  return {
    ...target.composerTargetStore,
    ...target.initialTargetState,
    ...target.runtimeTargetSelection,
    ...target.sourceContextState,
    ...target.workspaceIdentityState,
    ...target.asyncComposerState,
    ...target.providerRuntimeSync,
    ...target.derivedComposerState,
    ...external.hostRuntimeEffects,
    ...external.linkedItemLookupEffects,
    ...external.githubSourceApplication,
    ...external.githubSubmitResolution,
    ...source.sourceIdentityActions,
    ...source.attachmentDropState,
    ...source.targetChangeActions,
    ...source.projectTargetActions,
    ...source.branchStartPointActions,
    ...source.githubProviderSelection,
    ...source.gitlabProviderSelection,
    ...source.workItemSourceActions,
    ...source.issueSourceActions,
    ...source.composerNavigationActions,
    ...submit.folderSubmitOrchestration,
    ...submit.fullSubmitSourcePreparation,
    ...submit.fullSubmitPreparation,
    ...submit.fullCreationExecution,
    ...submit.fullSubmitOrchestration,
    ...submit.multipleCreateReset,
    ...submit.quickSubmitSourcePreparation,
    ...submit.quickSubmitPreparation,
    ...submit.quickCreationExecution,
    ...submit.quickSubmitAction
  }
}
