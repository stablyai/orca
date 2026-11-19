import type { RemoteServerUpdaterSnapshot } from '../../../../../shared/remote-runtime/host-catalog/remote-server-update'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'
import type { RemoteServerUpdateTransport } from './remote-server-update-coordinator'
import { updaterMessageText } from '@/app-shell/updates/updater-message-copy'

type PollingTransport = {
  getUpdaterStatus: (environmentId: string) => Promise<RemoteServerUpdaterSnapshot>
  now?: () => number
  wait: (milliseconds: number) => Promise<void>
}

type PollingTiming = {
  operationTimeoutMs: number
  pollIntervalMs: number
}

function hasRemoteUpdateCheckResult({ status }: RemoteServerUpdaterSnapshot): boolean {
  return (
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'downloaded' ||
    status.state === 'not-available'
  )
}

export async function checkRemoteServerUpdater(
  environmentId: string,
  transport: PollingTransport & Pick<RemoteServerUpdateTransport, 'check'>,
  options: UpdateCheckOptions,
  timing: PollingTiming
): Promise<RemoteServerUpdaterSnapshot> {
  const first = await transport.check(environmentId, options)
  return hasRemoteUpdateCheckResult(first)
    ? first
    : pollRemoteServerUpdater(
        environmentId,
        transport,
        timing,
        hasRemoteUpdateCheckResult,
        () => undefined
      )
}

export async function pollRemoteServerUpdater(
  environmentId: string,
  transport: PollingTransport,
  timing: PollingTiming,
  accept: (snapshot: RemoteServerUpdaterSnapshot) => boolean,
  onSnapshot: (snapshot: RemoteServerUpdaterSnapshot) => void
): Promise<RemoteServerUpdaterSnapshot> {
  const now = transport.now ?? Date.now
  const deadline = now() + timing.operationTimeoutMs
  while (now() < deadline) {
    const snapshot = await transport.getUpdaterStatus(environmentId)
    if (snapshot.status.state === 'error') {
      throw new Error(updaterMessageText(snapshot.status))
    }
    onSnapshot(snapshot)
    if (accept(snapshot)) {
      return snapshot
    }
    await transport.wait(timing.pollIntervalMs)
  }
  throw new Error('remote_update_updater_timeout')
}
