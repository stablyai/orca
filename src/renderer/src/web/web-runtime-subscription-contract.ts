import type { WebRuntimeClient } from './web-runtime-client'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from './web-runtime-request-registry'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export type WebRuntimeSubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
  onTransportInterrupted?: () => void
  onTransportReplayed?: () => void
}

export type WebRuntimeTransportSubscription = {
  id: string
  method: string
  params: unknown
  callbacks: WebRuntimeSubscriptionCallbacks
  needsReplay: boolean
}

export type WebRuntimeSubscribeOptions = {
  expectedEnvironmentRuntimeId?: string
  beforeSend?: () => void
  signal?: AbortSignal
  timeoutMs?: number
  buildUnsubscribe?: (params: unknown) => { method: string; params: unknown } | null
}

export type WebRuntimeTransportSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export async function pinWebRuntimeSubscription(
  client: Pick<WebRuntimeClient, 'call' | 'connectionEpoch'>,
  options: WebRuntimeSubscribeOptions,
  connected: Promise<void>
): Promise<number> {
  await waitForPromiseWithSignal(connected, options.signal)
  throwIfSignalAborted(options.signal)
  const epoch = client.connectionEpoch
  const status = await client.call('status.get', undefined, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    expectedConnectionEpoch: epoch
  })
  if (!status.ok || status._meta?.runtimeId !== options.expectedEnvironmentRuntimeId) {
    throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
  }
  return epoch
}
