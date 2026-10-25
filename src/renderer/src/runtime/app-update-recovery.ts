import {
  AppUpdateBatchSchema,
  remoteUpdateNeedsAttention,
  type AppUpdateBatch,
  type AppUpdateRemote
} from '../../../shared/app-update-batch'
import { hasReachedAppVersion } from '../../../shared/app-version'
import { remoteServerUpdateTransportForRevision } from './remote-server-update-transport'
import {
  confirmRemoteServerUpdate,
  type RemoteServerUpdateEntry
} from './remote-server-update-coordinator'

export function appUpdateRemoteEntry(remote: AppUpdateRemote): RemoteServerUpdateEntry {
  return {
    ...remote,
    supportsPinnedInstall: true,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null
  }
}

export function appUpdateCheckpoint(entry: RemoteServerUpdateEntry): AppUpdateRemote {
  if (entry.pairingRevision === undefined) {
    throw new Error('Refresh the remote inventory before updating.')
  }
  return {
    environmentId: entry.environmentId,
    name: entry.name,
    currentVersion: entry.currentVersion,
    targetVersion: entry.targetVersion,
    runtimeId: entry.runtimeId,
    pairingRevision: entry.pairingRevision,
    phase:
      entry.phase === 'available'
        ? 'queued'
        : entry.phase === 'manual' || entry.phase === 'offline' || entry.phase === 'checking'
          ? 'failed'
          : entry.phase,
    progress: entry.progress,
    error: entry.error
  }
}

export async function recoverAppUpdateBatch(batch: AppUpdateBatch): Promise<AppUpdateBatch> {
  const remotes = await Promise.all(
    batch.remotes.map(async (remote): Promise<AppUpdateRemote> => {
      if (
        remote.phase === 'restarting' ||
        remote.phase === 'verify-after-restart' ||
        remote.phase === 'not-confirmed'
      ) {
        return appUpdateCheckpoint(
          await confirmRemoteServerUpdate(
            appUpdateRemoteEntry(remote),
            remoteServerUpdateTransportForRevision(remote.pairingRevision)
          )
        )
      }
      if (
        remote.phase === 'downloading' ||
        remote.phase === 'checking-update' ||
        remote.phase === 'ready' ||
        remote.phase === 'queued'
      ) {
        return {
          ...remote,
          phase: 'failed',
          error:
            'The update was interrupted before installation. Retry this remote to check its state.'
        }
      }
      return remote
    })
  )
  return { ...batch, remotes, stage: 'recovery', error: null }
}

export async function loadAppUpdateRecovery(): Promise<{
  appUpdateLocalVersion: string
  appUpdateBatch: AppUpdateBatch | null
} | null> {
  const ui = await window.api.ui.get()
  const parsed = AppUpdateBatchSchema.safeParse(ui.appUpdateBatch)
  if (!parsed.success) {
    return null
  }
  const localVersion = await window.api.updater.getVersion()
  if (localVersion === 'web') {
    return null
  }
  const batch = await recoverAppUpdateBatch(parsed.data)
  return {
    appUpdateLocalVersion: localVersion,
    appUpdateBatch:
      hasReachedAppVersion(localVersion, batch.targetVersion) &&
      !batch.remotes.some(remoteUpdateNeedsAttention)
        ? null
        : batch
  }
}
