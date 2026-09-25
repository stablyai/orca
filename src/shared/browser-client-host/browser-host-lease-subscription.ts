import type { BrowserClientHostAttachParams } from '../browser-client-host-protocol'
import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../runtime-rpc-envelope'

export type BrowserHostLeaseSubscription = {
  close(): void
  // Must remain bound to this authenticated connection, including after replacement.
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
}

export type BrowserHostLeaseSubscriptionCallbacks = {
  onResponse(response: RuntimeRpcResponse<unknown>): void
  onError(error: RemoteRuntimeClientError): void
  onClose(): void
}

// Deliver callbacks only after resolution lets the receiver install the exact-connection sender.
export type SubscribeBrowserHostLease = (
  params: ReturnType<typeof BrowserClientHostAttachParams.parse>,
  timeoutMs: number,
  callbacks: BrowserHostLeaseSubscriptionCallbacks
) => Promise<BrowserHostLeaseSubscription>
