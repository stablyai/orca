import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { ensureRuntimeEnvironmentCompatible } from './runtime-rpc-client'

type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export async function subscribeRuntimeRpc(
  args: {
    selector: string
    method: string
    params?: unknown
    timeoutMs?: number
  },
  callbacks: {
    onResponse: (response: RuntimeRpcResponse<unknown>) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  }
): Promise<RuntimeEnvironmentSubscriptionHandle> {
  // Why: subscriptions bypass callRuntimeRpc, but must share its compatibility
  // fence before opening any saved runtime's long-lived session stream.
  await ensureRuntimeEnvironmentCompatible(args.selector, { timeoutMs: args.timeoutMs })
  return window.api.runtimeEnvironments.subscribe(args, callbacks)
}
