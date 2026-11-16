import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Opens accounts.subscribe on this device's runtime or on a paired host. */
export function openProviderAccountsStream(
  target: RuntimeClientTarget,
  timeoutMs: number,
  callbacks: {
    onResponse: (response: RuntimeRpcResponse<unknown>) => void
    onError: (error: { message: string }) => void
    onClose: () => void
  }
): Promise<{ unsubscribe: () => void }> {
  return target.kind === 'local'
    ? window.api.runtime.subscribe(
        { method: 'accounts.subscribe', params: null },
        callbacks.onResponse
      )
    : window.api.runtimeEnvironments.subscribe(
        { selector: target.environmentId, method: 'accounts.subscribe', timeoutMs },
        callbacks
      )
}
