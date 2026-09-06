import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame } from '../../../shared/runtime-rpc-envelope'
import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { createWebRuntimeUnauthorizedError } from './web-runtime-client-error'
import { decrypt, decryptBytes } from './web-e2ee'
import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'

export type WebRuntimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
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
  getSharedKey: () => Uint8Array | null
  getSocket: () => WebSocket | null
  pairingToken: string
  pending: Map<string, WebRuntimePendingRequest>
  subscriptions: Map<string, WebRuntimeTransportSubscription>
  sendEncrypted: (message: unknown) => boolean
  setConnected: () => void
  setAuthFailed: () => void
  rejectUnauthorized: (error: Error) => void
  notifyUnauthorized: () => void
}

export async function routeWebRuntimeConnectionFrame(
  rawData: unknown,
  sourceWs: WebSocket | undefined,
  context: WebRuntimeConnectionFrameContext
): Promise<void> {
  const raw = typeof rawData === 'string' ? rawData : null
  const sharedKey = context.getSharedKey()
  if (context.getState() === 'handshaking') {
    if (raw === null || !sharedKey) {
      return
    }
    try {
      const control = JSON.parse(raw) as { type?: unknown }
      if (control.type === 'e2ee_ready') {
        context.sendEncrypted({
          type: 'e2ee_auth',
          deviceToken: context.pairingToken,
          clientCapabilities: [
            SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
            AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
            WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
            WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
            WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
          ]
        })
        return
      }
    } catch {
      // The authenticated control frame is encrypted, so non-JSON is normal here.
    }
    const plaintext = decrypt(raw, sharedKey)
    if (plaintext === null) {
      return
    }
    try {
      const control = JSON.parse(plaintext) as {
        type?: unknown
        error?: { code?: string; message?: string }
      }
      if (control.type === 'e2ee_authenticated') {
        context.setConnected()
      } else if (control.type === 'e2ee_error' || control.error?.code === 'unauthorized') {
        const error = createWebRuntimeUnauthorizedError()
        context.setAuthFailed()
        context.rejectUnauthorized(error)
        context.notifyUnauthorized()
        context.getSocket()?.close()
      }
    } catch {
      // Ignore malformed handshake payloads; the server will close on timeout.
    }
    return
  }

  if (context.getState() !== 'connected' || !sharedKey) {
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
    const plaintext = decryptBytes(encrypted, sharedKey)
    if (!plaintext) {
      return
    }
    for (const subscription of context.subscriptions.values()) {
      subscription.callbacks.onBinary?.(plaintext)
    }
    return
  }

  const plaintext = decrypt(raw, sharedKey)
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
  if (isRuntimeFailureResponse(response) && response.error.code === 'unauthorized') {
    const error = createWebRuntimeUnauthorizedError()
    context.setAuthFailed()
    context.rejectUnauthorized(error)
    context.notifyUnauthorized()
    context.getSocket()?.close()
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
