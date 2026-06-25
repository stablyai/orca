import { decrypt } from './e2ee-crypto'
import { encrypt } from './e2ee-crypto'
import type WebSocket from 'ws'
import { RemoteRuntimeClientError } from './remote-runtime-client'
import {
  invalidRemoteRuntimeResponseError,
  parseRemoteRuntimeRpcFrame
} from './remote-runtime-request-frames'
import type {
  SharedControlConnectionState,
  SharedControlLogicalSubscription
} from './remote-runtime-shared-control-types'

export function parseSharedControlFrame(
  frame: string,
  sharedKey: Uint8Array | null,
  state: SharedControlConnectionState
):
  | { type: 'auth'; plaintext: string }
  | {
      type: 'frame'
      frame: Exclude<ReturnType<typeof parseRemoteRuntimeRpcFrame>, { type: 'error' }>
    }
  | { type: 'error'; error: RemoteRuntimeClientError } {
  if (!sharedKey) {
    return {
      type: 'error',
      error: invalidRemoteRuntimeResponseError('Remote Orca runtime returned a frame before E2EE.')
    }
  }
  const plaintext = decrypt(frame, sharedKey)
  if (plaintext === null) {
    return {
      type: 'error',
      error: invalidRemoteRuntimeResponseError(
        'Remote Orca runtime returned an undecryptable frame.'
      )
    }
  }
  if (state === 'awaiting_authenticated') {
    return { type: 'auth', plaintext }
  }
  const parsed = parseRemoteRuntimeRpcFrame(plaintext)
  if (parsed.type === 'error') {
    return parsed
  }
  return { type: 'frame', frame: parsed }
}

export function getSubscriptionId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const value = (result as { subscriptionId?: unknown }).subscriptionId
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function isEndResult(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && (result as { type?: unknown }).type === 'end'
  )
}

export function getCleanupRequest(
  subscription: SharedControlLogicalSubscription<unknown>
): { method: string; params: unknown } | null {
  if (subscription.method === 'accounts.subscribe' && subscription.remoteSubscriptionId) {
    return cleanupBySubscriptionId('accounts.unsubscribe', subscription.remoteSubscriptionId)
  }
  if (subscription.method === 'notifications.subscribe' && subscription.remoteSubscriptionId) {
    return cleanupBySubscriptionId('notifications.unsubscribe', subscription.remoteSubscriptionId)
  }
  if (
    subscription.method === 'runtime.clientEvents.subscribe' &&
    subscription.remoteSubscriptionId
  ) {
    return cleanupBySubscriptionId(
      'runtime.clientEvents.unsubscribe',
      subscription.remoteSubscriptionId
    )
  }
  if (subscription.method === 'files.watch' && subscription.remoteSubscriptionId) {
    return cleanupBySubscriptionId('files.unwatch', subscription.remoteSubscriptionId)
  }
  if (subscription.method === 'session.tabs.subscribe') {
    const params =
      typeof subscription.params === 'object' && subscription.params !== null
        ? { ...subscription.params, subscriptionId: subscription.requestId }
        : subscription.params
    return { method: 'session.tabs.unsubscribe', params }
  }
  if (subscription.method === 'session.tabs.subscribeAll') {
    return {
      method: 'session.tabs.unsubscribeAll',
      params: { subscriptionId: subscription.requestId }
    }
  }
  return null
}

export function formatSharedControlCloseMessage(code: number, reason: Buffer): string {
  const reasonText = reason.toString().trim()
  if (code !== 1005 && code !== 1006 && reasonText) {
    return `Remote Orca runtime closed the connection (${code}: ${reasonText}).`
  }
  if (code !== 1005 && code !== 1006) {
    return `Remote Orca runtime closed the connection (${code}).`
  }
  return 'Remote Orca runtime closed the connection.'
}

export function sendSharedControlEncrypted(args: {
  state: SharedControlConnectionState
  ws: WebSocket | null
  sharedKey: Uint8Array | null
  payload: unknown
}): boolean {
  if (args.state !== 'ready' && args.state !== 'awaiting_authenticated') {
    return false
  }
  if (!args.ws || args.ws.readyState !== 1 || !args.sharedKey) {
    return false
  }
  args.ws.send(encrypt(JSON.stringify(args.payload), args.sharedKey))
  return true
}

export function toRemoteRuntimeClientError(error: unknown): RemoteRuntimeClientError {
  if (error instanceof RemoteRuntimeClientError) {
    return error
  }
  if (error instanceof Error) {
    return new RemoteRuntimeClientError('runtime_error', error.message)
  }
  return new RemoteRuntimeClientError('runtime_error', String(error))
}

function cleanupBySubscriptionId(
  method: string,
  subscriptionId: string
): { method: string; params: unknown } {
  return { method, params: { subscriptionId } }
}
