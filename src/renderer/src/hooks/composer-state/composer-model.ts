import type { ComposerAsyncModel } from './async-model'
import type { ComposerDerivedModel } from './derived-model'
import type { ComposerIdentityModel } from './identity-model'
import type { ComposerInitialTargetModel } from './initial-target-model'
import type { ComposerProviderSyncModel } from './provider-sync-model'
import type { ComposerRuntimeTargetModel } from './runtime-target-model'
import type { ComposerSourceContextModel } from './source-context-model'
import type { ComposerSourceModel } from './composer-source-model'
import type { ComposerSubmitModel } from './composer-submit-model'
import type { ComposerTargetStoreModel } from './target-store-model'

export type ComposerTargetModel = ComposerTargetStoreModel &
  ComposerInitialTargetModel &
  ComposerRuntimeTargetModel &
  ComposerSourceContextModel &
  ComposerIdentityModel &
  ComposerAsyncModel &
  ComposerProviderSyncModel &
  ComposerDerivedModel

export type ComposerModel = ComposerTargetModel & ComposerSourceModel & ComposerSubmitModel
