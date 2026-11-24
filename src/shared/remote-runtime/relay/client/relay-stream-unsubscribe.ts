// How a client releases a host stream it opened: by the request that opened it, by the stream's own
// params, or by the subscription id the host names in its `ready` frame. Shared by the phone and the
// desktop's relay clients.
import { buildNativeChatUnsubscribe } from '../../../native-chat/transcript/streaming/native-chat-stream-unsubscribe'

export type StreamUnsubscribe = { method: string; params: Record<string, unknown> }

// Streams whose host names its registration only in the `ready` frame. The transport that saw that
// frame is the only holder of a current id, so it alone sends the release.
const READY_STREAM_RELEASE_METHODS: ReadonlyMap<string, string> = new Map([
  ['browser.screencast', 'browser.screencast.unsubscribe'],
  ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe'],
  ['notifications.subscribe', 'notifications.unsubscribe'],
  ['accounts.subscribe', 'accounts.unsubscribe']
])

export function isReadyIdStream(method: string | undefined): boolean {
  return method !== undefined && READY_STREAM_RELEASE_METHODS.has(method)
}

export function buildReadyStreamUnsubscribe(
  method: string,
  subscriptionId: string
): { method: string; params: { subscriptionId: string } } | null {
  const release = READY_STREAM_RELEASE_METHODS.get(method)
  return release ? { method: release, params: { subscriptionId } } : null
}

// Centralize method-specific unsubscribe echoes for explicit host teardown; return null when none is needed.
export function buildStreamUnsubscribe(
  method: string | undefined,
  params: unknown,
  requestId?: string
): StreamUnsubscribe | null {
  if (!params || typeof params !== 'object') {
    return null
  }
  if (method === 'session.tabs.subscribe') {
    const worktree = (params as { worktree?: unknown }).worktree
    return typeof worktree === 'string'
      ? {
          method: 'session.tabs.unsubscribe',
          params: { worktree, ...(requestId ? { subscriptionId: requestId } : {}) }
        }
      : null
  }
  if (method === 'agentSession.subscribe') {
    const sessionId = (params as { sessionId?: unknown }).sessionId
    // The host keys each transcript stream by its frame id; without it every stream of the
    // session on this socket would end.
    return typeof sessionId === 'string' && requestId
      ? { method: 'agentSession.unsubscribe', params: { sessionId, subscriptionId: requestId } }
      : null
  }
  if (method === 'orchestration.workerApprovalsSubscribe') {
    // The host names each approvals stream by the request that opened it.
    return requestId
      ? {
          method: 'orchestration.workerApprovalsUnsubscribe',
          params: { subscriptionId: requestId }
        }
      : null
  }
  if (method === 'nativeChat.subscribe') {
    const subscriptionId = (params as { subscriptionId?: unknown }).subscriptionId
    if (typeof subscriptionId === 'string') {
      return { method: 'nativeChat.unsubscribe', params: { subscriptionId } }
    }
    // Backward compatibility for callers that predate explicit cleanup tokens.
    const agent = (params as { agent?: unknown }).agent
    const sessionId = (params as { sessionId?: unknown }).sessionId
    return typeof agent === 'string' && typeof sessionId === 'string'
      ? buildNativeChatUnsubscribe(agent, sessionId)
      : null
  }
  return null
}
