import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame } from '../../../shared/runtime-rpc-envelope'
import type {
  PairedE2EEAuthReply,
  PairedE2EEClientHandshake
} from '../../../shared/paired-e2ee-client-handshake'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from './web-runtime-client-capabilities'
import type { WebRuntimeAuthPlan } from './web-runtime-credential-source'
import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'

export type WebRuntimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  // A v2 token socket registering this browser's key; requests still wait for 'connected'.
  | 'migrating'
  | 'connected'
  | 'auth-failed'

export type WebRuntimePendingRequest = {
  method: string
  resolve: (response: RuntimeRpcResponse<unknown>) => void
  reject: (error: Error) => void
  timeout: number
}

type WebRuntimeConnectionFrameContext = {
  getState: () => WebRuntimeConnectionState
  getHandshake: () => PairedE2EEClientHandshake | null
  getSocket: () => WebSocket | null
  pending: Map<string, WebRuntimePendingRequest>
  subscriptions: Map<string, WebRuntimeTransportSubscription>
  sendAuth: (handshake: PairedE2EEClientHandshake) => void
  setConnected: () => void
  authRejected: (reply: Extract<PairedE2EEAuthReply, { kind: 'rejected' }>) => void
}

export function sealWebRuntimeAuth(
  handshake: PairedE2EEClientHandshake,
  deviceToken: string
): Promise<string> {
  return handshake.sealAuth(
    { kind: 'token', deviceToken },
    { clientCapabilities: WEB_RUNTIME_CLIENT_CAPABILITIES }
  )
}

/** The auth frame for this socket's plan; key auth carries capabilities, v2 token auth cannot. */
export function sealWebRuntimePlanAuth(
  handshake: PairedE2EEClientHandshake,
  plan: WebRuntimeAuthPlan | null,
  fallbackToken: string
): Promise<string> {
  return plan?.kind === 'device-key'
    ? handshake.sealAuth(
        { kind: 'device-key', deviceId: plan.deviceId, sign: plan.key.sign },
        { clientCapabilities: WEB_RUNTIME_CLIENT_CAPABILITIES }
      )
    : sealWebRuntimeAuth(handshake, plan?.deviceToken ?? fallbackToken)
}

export async function routeWebRuntimeConnectionFrame(
  rawData: unknown,
  sourceWs: WebSocket | undefined,
  context: WebRuntimeConnectionFrameContext
): Promise<void> {
  const raw = typeof rawData === 'string' ? rawData : null
  const handshake = context.getHandshake()
  if (context.getState() === 'handshaking') {
    if (raw === null || !handshake) {
      return
    }
    // The authenticated control frame is encrypted, so anything but a ready is decrypted below.
    if (handshake.acceptReadyText(raw) === 'accepted') {
      context.sendAuth(handshake)
      return
    }
    const plaintext = handshake.channel.openText(raw)
    if (plaintext === null) {
      return
    }
    // Malformed handshake payloads are ignored; the server closes on timeout.
    const reply = handshake.classifyAuthReply(plaintext)
    if (reply.kind === 'authenticated') {
      context.setConnected()
    } else if (
      reply.kind === 'rejected' &&
      (reply.type === 'e2ee_error' || reply.errorCode === 'unauthorized')
    ) {
      context.authRejected(reply)
    }
    return
  }

  const state = context.getState()
  if ((state !== 'connected' && state !== 'migrating') || !handshake) {
    return
  }
  if (raw === null) {
    const encrypted = await websocketPayloadToUint8(rawData)
    if (sourceWs && context.getSocket() !== sourceWs) {
      return
    }
    if (!encrypted) {
      return
    }
    const plaintext = handshake.channel.openBinary(encrypted)
    if (!plaintext) {
      return
    }
    for (const subscription of context.subscriptions.values()) {
      subscription.callbacks.onBinary?.(plaintext)
    }
    return
  }

  const plaintext = handshake.channel.openText(raw)
  if (plaintext === null) {
    return
  }
  let response: RuntimeRpcResponse<unknown> | Record<string, unknown>
  try {
    response = JSON.parse(plaintext) as RuntimeRpcResponse<unknown> | Record<string, unknown>
  } catch {
    return
  }
  if (isKeepaliveFrame(response) || !('id' in response) || typeof response.id !== 'string') {
    return
  }
  // Why connected only: a failed key registration is not a revoked pairing.
  if (
    state === 'connected' &&
    isRuntimeFailureResponse(response) &&
    response.error.code === 'unauthorized'
  ) {
    context.authRejected({ kind: 'rejected', type: null, errorCode: 'unauthorized' })
    return
  }

  const subscription = context.subscriptions.get(response.id)
  if (subscription) {
    const subscriptionResponse = response as RuntimeRpcResponse<unknown>
    if (subscriptionResponse.ok === false) {
      context.subscriptions.delete(response.id)
    }
    subscription.callbacks.onResponse(subscriptionResponse)
    if (subscriptionResponse.ok && isEndResult(subscriptionResponse.result)) {
      context.subscriptions.delete(response.id)
      subscription.callbacks.onClose?.()
    }
    return
  }
  const pending = context.pending.get(response.id)
  if (!pending) {
    return
  }
  context.pending.delete(response.id)
  window.clearTimeout(pending.timeout)
  pending.resolve(response as RuntimeRpcResponse<unknown>)
}

function isRuntimeFailureResponse(
  response: RuntimeRpcResponse<unknown> | Record<string, unknown>
): response is RuntimeRpcResponse<unknown> & { ok: false } {
  return (
    'ok' in response &&
    response.ok === false &&
    'error' in response &&
    !!response.error &&
    typeof response.error === 'object' &&
    'code' in response.error
  )
}

function isEndResult(value: unknown): value is { type: 'end' } {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'end'
}

async function websocketPayloadToUint8(
  value: unknown
): Promise<Uint8Array<ArrayBufferLike> | null> {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }
  return null
}
