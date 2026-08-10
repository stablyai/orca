import type { RemoteWorkspacePatchResult } from '../../../shared/remote-workspace-types'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../store/types'

export function applyRemoteWorkspacePatchStatus(
  store: AppState,
  targetId: string,
  result: RemoteWorkspacePatchResult | undefined
): void {
  if (!result) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'offline',
      direction: 'push',
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable')
    })
  } else if (result.ok) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.f8aaf2bde3', 'Workspace uploaded')
    })
  } else {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
      direction: 'push',
      revision: result.snapshot?.revision,
      updatedAt: result.snapshot?.updatedAt,
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
