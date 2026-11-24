import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { subscribeRuntimeEnvironment } from '../environment-revisions/runtime-environment-pairing-refresh'
import { getRuntimeEnvironmentRevision } from '../environment-revisions/runtime-environment-revision'
import { sharedBotHostFor } from '../../hosts/shared-bot-hosts/shared-bot-host-catalog'

export type RuntimeRpcSubscriptionHandlers = {
  /** Each successful frame's result. */
  onEvent: (result: unknown, runtimeId?: string) => void
  onError: (error: unknown) => void
  /** Only a remote transport reports its own close; the local stream ends with a frame. */
  onClose: () => void
}

/** The streaming counterpart of `callRuntimeRpc`: the same method over either transport. */
export async function subscribeRuntimeRpc(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  handlers: RuntimeRpcSubscriptionHandlers
): Promise<{ unsubscribe: () => void }> {
  const onResponse = (response: RuntimeRpcResponse<unknown>): void => {
    if (!response.ok) {
      handlers.onError(response.error)
      return
    }
    handlers.onEvent(response.result, response._meta.runtimeId)
  }
  if (target.kind === 'local') {
    return window.api.runtime.subscribe({ method, params }, onResponse)
  }
  const sharedHost = sharedBotHostFor(target)
  if (sharedHost) {
    return window.api.sharedBotHosts.subscribe(
      { environmentId: sharedHost.environmentId, method, params },
      onResponse
    )
  }
  return subscribeRuntimeEnvironment(
    {
      selector: target.environmentId,
      method,
      params,
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(target.environmentId)
    },
    { onResponse, onError: handlers.onError, onClose: handlers.onClose }
  )
}
