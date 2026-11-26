import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { serializeRemoteRuntimePayload } from '../remote-runtime-memory-limits'
import type { AuthenticatedRuntimeChannel } from './remote-runtime-authenticated-channel'
import type {
  SharedControlConnectionState,
  SharedControlLogicalSubscription
} from './remote-runtime-shared-control-types'

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
  if (subscription.method === 'orchestration.workerApprovalsSubscribe') {
    return cleanupBySubscriptionId(
      'orchestration.workerApprovalsUnsubscribe',
      subscription.requestId
    )
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
  channel: AuthenticatedRuntimeChannel | null
  payload: unknown
}): boolean {
  if (!canSendSharedControl(args)) {
    return false
  }
  let serialized: string
  try {
    serialized = serializeRemoteRuntimePayload(args.payload)
  } catch {
    return false
  }
  return sendSharedControlEncryptedSerialized({ ...args, serialized })
}

export function sendSharedControlEncryptedSerialized(args: {
  state: SharedControlConnectionState
  channel: AuthenticatedRuntimeChannel | null
  serialized: string
}): boolean {
  return canSendSharedControl(args) && args.channel.sendText(args.serialized)
}

function canSendSharedControl(args: {
  state: SharedControlConnectionState
  channel: AuthenticatedRuntimeChannel | null
}): args is { state: SharedControlConnectionState; channel: AuthenticatedRuntimeChannel } {
  return (
    (args.state === 'ready' || args.state === 'awaiting_authenticated') &&
    args.channel?.state() === 'open'
  )
}

export function toRemoteRuntimeClientError(error: unknown): RemoteRuntimeClientError {
  if (error instanceof RemoteRuntimeClientError) {
    return error
  }
  if (error instanceof Error) {
    const data =
      typeof error === 'object' && error !== null && 'data' in error
        ? (error as { data?: unknown }).data
        : undefined
    return new RemoteRuntimeClientError('runtime_error', error.message, { data })
  }
  return new RemoteRuntimeClientError('runtime_error', String(error))
}

function cleanupBySubscriptionId(
  method: string,
  subscriptionId: string
): { method: string; params: unknown } {
  return { method, params: { subscriptionId } }
}
