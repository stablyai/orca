import { hasReachedAppVersion } from '../../../shared/app-version'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../../shared/remote-server-update'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { readRemoteServerInstallFailure } from './remote-server-install-failure-probe'

type RestartWaitTransport = {
  getRuntimeStatus: (environmentId: string, timeoutMs?: number) => Promise<RuntimeStatus>
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

/**
 * Waits for the replacement process to answer on the target version and returns its runtime status.
 * Throws the server's own install-failure text as soon as the *original* process publishes one —
 * without that, a server that could not restart is indistinguishable from a slow one until the
 * reconnect budget runs out, and the user is told the wrong thing.
 */
export async function waitForReplacementRuntime(
  environmentId: string,
  transport: RestartWaitTransport,
  install: RemoteServerUpdateInstallResult,
  timing: RestartWaitTiming
): Promise<RuntimeStatus> {
  const now = transport.now ?? Date.now
  const deadline = now() + timing.reconnectTimeoutMs
  // Why: the install RPC returns before the installer fires, so an error on the first tick belongs to an earlier attempt.
  let probed = false
  while (now() < deadline) {
    // Why: an RPC allowed to outlive the deadline drags the whole wait past the budget the caller set.
    const rpcTimeoutMs = Math.min(RESTART_WAIT_RPC_TIMEOUT_MS, deadline - now())
    let installFailure: string | null = null
    try {
      const status = await transport.getRuntimeStatus(environmentId, rpcTimeoutMs)
      const version = status.appVersion?.trim() ?? ''
      const reachedTarget = hasReachedAppVersion(version, install.targetVersion)
      if (status.runtimeId !== install.runtimeId && reachedTarget) {
        return status
      }
      // Why: the status RPC already spent part of rpcTimeoutMs, so the probe re-reads what is left
      // rather than starting a second full budget of its own.
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
      throw new Error(installFailure)
    }
    const waitMs = Math.min(timing.pollIntervalMs, deadline - now())
    if (waitMs > 0) {
      await transport.wait(waitMs)
    }
  }
  throw new Error('remote_update_reconnect_timeout')
}
