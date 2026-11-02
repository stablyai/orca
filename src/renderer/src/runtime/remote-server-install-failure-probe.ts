import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../../shared/remote-server-update'
import type { RuntimeStatus } from '../../../shared/runtime-types'

type InstallFailureProbeTransport = {
  getUpdaterStatus: (
    environmentId: string,
    timeoutMs?: number
  ) => Promise<RemoteServerUpdaterSnapshot>
}

/** Install RPC accepts before installer runs; original runtime’s updater.getStatus exposes restart failure instead of a three-minute reconnect timeout. Both runtime-ID fences exclude other attempts. */
export async function readRemoteServerInstallFailure(
  environmentId: string,
  transport: InstallFailureProbeTransport,
  install: RemoteServerUpdateInstallResult,
  runtime: RuntimeStatus,
  timeoutMs?: number
): Promise<string | null> {
  if (runtime.runtimeId !== install.runtimeId) {
    return null
  }
  // Why: without an explicit deadline this inherits the RPC client's 15s default and can outlast the caller's own wait.
  const snapshot = await transport.getUpdaterStatus(environmentId, timeoutMs)
  if (snapshot.runtimeId !== install.runtimeId || snapshot.status.state !== 'error') {
    return null
  }
  return snapshot.status.message
}
