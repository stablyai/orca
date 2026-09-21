import type { RemoteWorkspaceObservedPatchResult } from '../../../shared/remote-workspace-types'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../store/types'

export type RemoteWorkspacePushAuthority = {
  revision: number
  updatedAt?: number
  hostObservationToken: string
}

function currentTransientAuthority(
  store: AppState,
  targetId: string,
  fallback: RemoteWorkspacePushAuthority
): RemoteWorkspacePushAuthority {
  const current = store.remoteWorkspaceSyncStatusByTargetId[targetId]
  return current?.hostObservationToken === fallback.hostObservationToken &&
    typeof current.revision === 'number'
    ? {
        revision: current.revision,
        updatedAt: current.updatedAt,
        hostObservationToken: current.hostObservationToken
      }
    : fallback
}

export function applyRemoteWorkspacePushStatus(
  store: AppState,
  targetId: string,
  result: RemoteWorkspaceObservedPatchResult | undefined,
  fallbackAuthority: RemoteWorkspacePushAuthority
): void {
  if (!result) {
    const authority = currentTransientAuthority(store, targetId, fallbackAuthority)
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'offline',
      direction: 'push',
      ...authority,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable')
    })
  } else if (result.ok) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      hostObservationToken: result.snapshot.hostObservationToken,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.f8aaf2bde3', 'Workspace uploaded')
    })
  } else {
    const authority =
      result.snapshot ?? currentTransientAuthority(store, targetId, fallbackAuthority)
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
      direction: 'push',
      ...authority,
      lastSyncedAt: Date.now(),
      message:
        result.message ??
        (result.reason === 'stale-revision'
          ? translate(
              'auto.hooks.useIpcEvents.workspaceChangedOnAnotherDevice',
              'Workspace changed on another device'
            )
          : translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable'))
    })
  }
}
