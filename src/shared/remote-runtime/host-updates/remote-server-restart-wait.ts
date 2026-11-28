import { hasReachedAppVersion } from '../../app-lifecycle/identity/app-version'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../host-catalog/remote-server-update'
import { readRemoteServerInstallFailure } from './remote-server-install-failure-probe'
import { RemoteServerUpdaterStatusError } from './remote-server-updater-polling'

/** Just what tells a replacement process apart: its id and the version it runs. */
export type RemoteServerRuntimeIdentity = { runtimeId: string; appVersion?: string | null }

type RestartWaitTransport<Status extends RemoteServerRuntimeIdentity> = {
  getRuntimeStatus: (
    environmentId: string,
    timeoutMs?: number,
    options?: { force?: true }
  ) => Promise<Status>
  getUpdaterStatus: (
    environmentId: string,
    timeoutMs?: number
  ) => Promise<RemoteServerUpdaterSnapshot>
  wait: (milliseconds: number) => Promise<void>
  now?: () => number
}

type RestartWaitTiming = {
  reconnectTimeoutMs: number
  pollIntervalMs: number
}

/** Per-call ceiling for the two poll RPCs; each tick also clamps to the time left. */
const RESTART_WAIT_RPC_TIMEOUT_MS = 10_000

/** Wait for a new runtime on target version. Report install failure from the original process immediately; otherwise failed restart looks merely slow until budget expiry. */
export async function waitForReplacementRuntime<Status extends RemoteServerRuntimeIdentity>(
  environmentId: string,
  transport: RestartWaitTransport<Status>,
  install: RemoteServerUpdateInstallResult,
  timing: RestartWaitTiming
): Promise<Status> {
  const now = transport.now ?? Date.now
  const deadline = now() + timing.reconnectTimeoutMs
  // Install returns before installer fires; first-tick errors belong to earlier attempts.
  let probed = false
  while (now() < deadline) {
    // Clamp each RPC to remaining time or it outlives the caller’s whole wait budget.
    const rpcTimeoutMs = Math.min(RESTART_WAIT_RPC_TIMEOUT_MS, deadline - now())
    let installFailure: Awaited<ReturnType<typeof readRemoteServerInstallFailure>> = null
    try {
      // A restart the user started must notice the new server now, not after a failure backoff.
      const status = await transport.getRuntimeStatus(environmentId, rpcTimeoutMs, { force: true })
      const version = status.appVersion?.trim() ?? ''
      const reachedTarget = hasReachedAppVersion(version, install.targetVersion)
      if (status.runtimeId !== install.runtimeId && reachedTarget) {
        return status
      }
      // Status spent part of this tick’s budget; re-read remaining time before probing.
      const probeTimeoutMs = Math.min(RESTART_WAIT_RPC_TIMEOUT_MS, deadline - now())
      installFailure =
        probed && probeTimeoutMs > 0
          ? await readRemoteServerInstallFailure(
              environmentId,
              transport,
              install,
              status,
              probeTimeoutMs
            )
          : null
      probed = true
    } catch {
      // A refused connection is expected while the server process is being replaced.
    }
    // Why: thrown outside the try so the loop's own catch cannot swallow the reason we came for.
    if (installFailure !== null) {
      throw new RemoteServerUpdaterStatusError(installFailure)
    }
    const waitMs = Math.min(timing.pollIntervalMs, deadline - now())
    if (waitMs > 0) {
      await transport.wait(waitMs)
    }
  }
  // A client whose timers stopped (a locked phone) reaches the deadline without having looked; one
  // last read keeps a computer already back on the new version from reading as lost.
  try {
    const status = await transport.getRuntimeStatus(environmentId, RESTART_WAIT_RPC_TIMEOUT_MS, {
      force: true
    })
    if (
      status.runtimeId !== install.runtimeId &&
      hasReachedAppVersion(status.appVersion?.trim() ?? '', install.targetVersion)
    ) {
      return status
    }
  } catch {
    // Still away.
  }
  throw new Error('remote_update_reconnect_timeout')
}
