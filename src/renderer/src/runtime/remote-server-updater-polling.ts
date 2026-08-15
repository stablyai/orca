import type { RemoteServerUpdaterSnapshot } from '../../../shared/remote-server-update'

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
    // Why: callers opt specific error snapshots in via accept — e.g. release-not-ready is a calm terminal state for checks, not a failure.
    if (snapshot.status.state === 'error' && !accept(snapshot)) {
      throw new Error(snapshot.status.message)
    }
    onSnapshot(snapshot)
    if (accept(snapshot)) {
      return snapshot
    }
    await transport.wait(timing.pollIntervalMs)
  }
  throw new Error('remote_update_updater_timeout')
}
