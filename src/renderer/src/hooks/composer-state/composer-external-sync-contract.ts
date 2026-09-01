import type { ComposerModel } from './composer-model'
export type ComposerExternalSyncState = {
  hostRuntimeEffects: Pick<ComposerModel, 'onConnectSelectedRepo' | 'onConnectSelectedProjectGroup'>
  linkedItemLookupEffects: Pick<
    ComposerModel,
    'canPrefetchSelectedRepoWorkItems' | 'prefetchSshConnectedGeneration'
  >
  githubSourceApplication: Pick<ComposerModel, 'applyLinkedWorkItem'>
  githubSubmitResolution: Pick<ComposerModel, 'resolvePendingSmartGitHubSubmit'>
}
