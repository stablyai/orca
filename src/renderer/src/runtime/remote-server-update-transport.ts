import type { RemoteServerUpdaterSnapshot } from '../../../shared/remote-server-update'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RemoteServerUpdateTransport } from './remote-server-update-coordinator'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'

export function remoteServerUpdateTransportForRevision(
  expectedEnvironmentPairingRevision?: number
): RemoteServerUpdateTransport {
  function call<TResult>(
    environmentId: string,
    method: string,
    params?: unknown,
    timeoutMs = 15_000
  ): Promise<TResult> {
    return (
      window.api.runtimeEnvironments
        .call({
          selector: environmentId,
          method,
          params,
          timeoutMs,
          expectedEnvironmentPairingRevision
        })
        // SAFETY: Method-specific callers select the declared result type for the bridge's unknown RPC envelope.
        .then((response) => unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>))
    )
  }
  return {
    getRuntimeStatus: (environmentId, timeoutMs) =>
      expectedEnvironmentPairingRevision === undefined
        ? window.api.runtimeEnvironments
            .getStatus({ selector: environmentId, timeoutMs })
            .then((response) => unwrapRuntimeRpcResult<RuntimeStatus>(response))
        : call<RuntimeStatus>(environmentId, 'status.get', undefined, timeoutMs),
    getUpdaterStatus: (environmentId, timeoutMs) =>
      call<RemoteServerUpdaterSnapshot>(environmentId, 'updater.getStatus', undefined, timeoutMs),
    check: (environmentId, options) =>
      call<RemoteServerUpdaterSnapshot>(environmentId, 'updater.check', options),
    download: (environmentId) =>
      call<RemoteServerUpdaterSnapshot>(environmentId, 'updater.download'),
    install: (environmentId, targetVersion) =>
      call(
        environmentId,
        'updater.install',
        targetVersion ? { expectedTargetVersion: targetVersion } : undefined
      ),
    wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  }
}

export const remoteServerUpdateTransport = remoteServerUpdateTransportForRevision()
