import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeClientTarget } from './runtime-client-target'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export type RuntimeRpcSubscriptionHandlers = {
  /** Each successful frame's result. */
  onEvent: (result: unknown) => void
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
    handlers.onEvent(response.result)
  }
  if (target.kind === 'local') {
    return window.api.runtime.subscribe({ method, params }, onResponse)
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
