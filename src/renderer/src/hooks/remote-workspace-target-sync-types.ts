import type {
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspaceObservedSnapshot
} from '../../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type {
  DirectSshPreparationInput,
  DirectSshPreparationOutcome,
  DirectSshPreparationToken
} from './direct-ssh-reconnect-coordinator'
import type { RemoteWorkspaceSnapshotPlacementStore } from './remote-workspace-snapshot-placement'

export type RemoteWorkspaceApi = {
  get: (args: { targetId: string }) => Promise<RemoteWorkspaceObservedSnapshot | null>
  setForConnectedTargets: (args: {
    session?: WorkspaceSessionState
    hydratedTargetIds?: string[]
    expectedRevisionsByTargetId: Record<string, number>
    expectedHostObservationTokensByTargetId: Record<string, string>
  }) => Promise<{ targetId: string; result: RemoteWorkspaceObservedPatchResult }[]>
}

export type RemoteWorkspaceTargetSyncDeps = {
  store: RemoteWorkspaceSnapshotPlacementStore
  remoteWorkspace: RemoteWorkspaceApi
  getCurrentAuthority: (targetId: string) => DirectSshAuthority | null
  isPreparationTokenCurrent: (token: DirectSshPreparationToken) => boolean
  capturePreparationInput: (
    authority: DirectSshAuthority,
    reason: 'workspace-snapshot',
    snapshotRevision: number
  ) => Promise<DirectSshPreparationInput | null>
  prepareOnly: (input: DirectSshPreparationInput) => Promise<DirectSshPreparationOutcome>
  finalizeHydratedTerminals: (authority: DirectSshAuthority) => number
}

export type RemoteWorkspaceTargetSync = {
  syncAfterConnect: (token: DirectSshPreparationToken) => Promise<void>
  applyUnsolicitedSnapshot: (
    targetId: string,
    snapshot: RemoteWorkspaceObservedSnapshot
  ) => Promise<void>
  stop: () => void
}
