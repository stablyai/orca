import type { RemoteServerUpdaterSnapshot } from '../host-catalog/remote-server-update'
import type { UpdateStatus } from '../../updater/update-status-types'

/** Carries the host's coded status so each client can word it in its own language. */
export class RemoteServerUpdaterStatusError extends Error {
  constructor(readonly status: Extract<UpdateStatus, { state: 'error' }>) {
    super(status.message)
  }
}

type PollingTransport = {
  getUpdaterStatus: (environmentId: string) => Promise<RemoteServerUpdaterSnapshot>
  now?: () => number
  wait: (milliseconds: number) => Promise<void>
}

type PollingTiming = {
  operationTimeoutMs: number
  pollIntervalMs: number
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
      throw new RemoteServerUpdaterStatusError(snapshot.status)
    }
    onSnapshot(snapshot)
    if (accept(snapshot)) {
      return snapshot
    }
    await transport.wait(timing.pollIntervalMs)
  }
  throw new Error('remote_update_updater_timeout')
}
