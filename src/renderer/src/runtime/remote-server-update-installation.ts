import { hasReachedAppVersion } from '../../../shared/app-version'
import type { RemoteServerUpdaterSnapshot } from '../../../shared/remote-server-update'
import type {
  RemoteServerUpdateEntry,
  RemoteServerUpdateTransport,
  RemoteServerUpdateTiming,
  RemoteServerUpdateRunOptions
} from './remote-server-update-coordinator'
import { waitForReplacementRuntime } from './remote-server-restart-wait'
import { readRemoteServerInstallFailure } from './remote-server-install-failure-probe'
import {
  remoteServerUpdateErrorMessage,
  isRemoteUpdateProtocolRefusal
} from './remote-server-update-errors'

export const DEFAULT_REMOTE_SERVER_UPDATE_TIMING: RemoteServerUpdateTiming = {
  operationTimeoutMs: 10 * 60 * 1000,
  reconnectTimeoutMs: 3 * 60 * 1000,
  pollIntervalMs: 500
}

export async function installPreparedRemoteServerUpdate(
  entry: RemoteServerUpdateEntry,
  transport: RemoteServerUpdateTransport,
  onProgress: (entry: RemoteServerUpdateEntry) => void,
  options: RemoteServerUpdateRunOptions = {},
  preparedSnapshot?: RemoteServerUpdaterSnapshot
): Promise<RemoteServerUpdateEntry> {
  let next = { ...entry }
  let installSubmitted = false
  let installAccepted = false
  try {
    if (options.freezeTarget && !entry.supportsPinnedInstall) {
      throw new Error('remote_update_pinned_install_required')
    }
    const snapshot = preparedSnapshot ?? (await transport.getUpdaterStatus(entry.environmentId))
    if (snapshot.status.state !== 'downloaded' || snapshot.status.version !== entry.targetVersion) {
      throw new Error('remote_update_not_downloaded')
    }
    next = { ...next, phase: 'restarting', runtimeId: snapshot.runtimeId, progress: null }
    await options.beforeInstall?.(next)
    onProgress(next)
    installSubmitted = true
    const install = await transport.install(
      entry.environmentId,
      options.freezeTarget ? (entry.targetVersion ?? undefined) : undefined
    )
    installAccepted = true
    if (install.targetVersion !== entry.targetVersion) {
      throw new Error('remote_update_installed_target_changed')
    }
    const replacement = await waitForReplacementRuntime(
      entry.environmentId,
      transport,
      install,
      options.timing ?? DEFAULT_REMOTE_SERVER_UPDATE_TIMING
    )
    next = {
      ...next,
      phase: 'updated',
      currentVersion: replacement.appVersion?.trim() ?? '',
      runtimeId: replacement.runtimeId,
      liveTabCount: replacement.liveTabCount,
      liveLeafCount: replacement.liveLeafCount
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const protocolRefused = isRemoteUpdateProtocolRefusal(error)
    const rejectedBeforeInstall = [
      'remote_update_requested_version_unavailable',
      'remote_update_not_downloaded',
      'remote_update_manual_required'
    ].includes(message)
    next = {
      ...next,
      phase:
        installSubmitted &&
        !rejectedBeforeInstall &&
        (protocolRefused ||
          !installAccepted ||
          message === 'remote_update_reconnect_timeout' ||
          message === 'remote_update_installed_target_changed')
          ? protocolRefused
            ? 'verify-after-restart'
            : 'not-confirmed'
          : 'failed',
      progress: null,
      error: remoteServerUpdateErrorMessage(error)
    }
  }
  onProgress(next)
  return next
}

export async function confirmRemoteServerUpdate(
  entry: RemoteServerUpdateEntry,
  transport: RemoteServerUpdateTransport
): Promise<RemoteServerUpdateEntry> {
  try {
    const status = await transport.getRuntimeStatus(entry.environmentId, 10_000)
    if (
      status.runtimeId !== entry.runtimeId &&
      hasReachedAppVersion(status.appVersion ?? '', entry.targetVersion)
    ) {
      return {
        ...entry,
        phase: 'updated',
        currentVersion: status.appVersion ?? null,
        runtimeId: status.runtimeId,
        error: null
      }
    }
    // A confirmed installer rejection is safe to retry; an unreachable host is not.
    const failure = await readRemoteServerInstallFailure(
      entry.environmentId,
      transport,
      { runtimeId: entry.runtimeId ?? '' },
      status,
      10_000
    )
    if (failure !== null) {
      return { ...entry, phase: 'failed', error: failure }
    }
    return {
      ...entry,
      phase: 'not-confirmed',
      error: remoteServerUpdateErrorMessage(new Error('remote_update_reconnect_timeout'))
    }
  } catch (error) {
    return { ...entry, phase: 'not-confirmed', error: remoteServerUpdateErrorMessage(error) }
  }
}
