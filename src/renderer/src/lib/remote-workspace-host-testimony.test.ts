import { describe, expect, it } from 'vitest'
import {
  hostHasAnsweredForTarget,
  type RemoteWorkspaceTestimonyState
} from './remote-workspace-host-testimony'

const TARGET_ID = 'ssh-target-1'

describe('hostHasAnsweredForTarget', () => {
  it('is false until a snapshot has landed for the target', () => {
    const emptyState: RemoteWorkspaceTestimonyState = {}
    expect(hostHasAnsweredForTarget(emptyState, TARGET_ID)).toBe(false)

    const pullingState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'pulling', direction: 'pull' }
      }
    }
    expect(hostHasAnsweredForTarget(pullingState, TARGET_ID)).toBe(false)
  })

  it('is false while the landed snapshot is in conflict, because the client picture is not the host picture', () => {
    const conflictState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'conflict' }
      }
    }
    expect(hostHasAnsweredForTarget(conflictState, TARGET_ID)).toBe(false)
  })

  it('is true once a non-conflicting snapshot has landed', () => {
    const syncedState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'synced', direction: 'pull' }
      }
    }
    expect(hostHasAnsweredForTarget(syncedState, TARGET_ID)).toBe(true)

    const noStatusState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID])
    }
    expect(hostHasAnsweredForTarget(noStatusState, TARGET_ID)).toBe(true)
  })
})
