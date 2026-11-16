import type { ComposerAsyncModel } from './async-model'
import type { ComposerDerivedModel } from './derived-model'
import type { ComposerIdentityModel } from './workspace-identity/identity-model'
import type { ComposerInitialTargetModel } from './workspace-target/initial-target-model'
import type { ComposerProviderSyncModel } from './workspace-setup/provider-sync-model'
import type { ComposerRuntimeTargetModel } from './workspace-target/runtime-target-model'
import type { ComposerSourceContextModel } from './linked-work-items/source-context-model'
import type { ComposerTargetStoreModel } from './workspace-target/target-store-model'

export type ComposerTargetState = {
  composerTargetStore: ComposerTargetStoreModel
  initialTargetState: ComposerInitialTargetModel
  runtimeTargetSelection: ComposerRuntimeTargetModel
  sourceContextState: ComposerSourceContextModel
  workspaceIdentityState: ComposerIdentityModel
  asyncComposerState: ComposerAsyncModel
  providerRuntimeSync: ComposerProviderSyncModel
  derivedComposerState: ComposerDerivedModel
}
