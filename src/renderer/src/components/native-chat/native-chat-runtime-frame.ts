import type {
  NativeChatAppendedMessages,
  NativeChatSubscriptionFrame
} from '../../../../preload/api-types'
import type { AgentSessionCurrentRequestsMarker } from '../../../../shared/agent-session-current-requests-wire'
import { parseRuntimeNativeChatTurnLifecycle } from './native-chat-runtime-contract'

export function readRuntimeNativeChatFrame(
  result: unknown,
  receivedInitial: boolean,
  limit: number | undefined
): { receivedInitial: boolean; frame: NativeChatSubscriptionFrame | null } {
  let outgoing: NativeChatSubscriptionFrame | null = null
  const frame = result as {
    type?: string
    messages?: NativeChatAppendedMessages
    hasMore?: boolean
    error?: string
    lifecycle?: unknown
    currentRequests?: AgentSessionCurrentRequestsMarker
    pending?: boolean
  }
  const lifecycle = parseRuntimeNativeChatTurnLifecycle(frame?.lifecycle)
  // Pending frames stop the spinner without claiming a settled initial transcript.
  const pending = frame?.pending === true
  if (
    (frame?.type === 'appended' || frame?.type === 'snapshot' || frame?.type === 'replacement') &&
    Array.isArray(frame.messages)
  ) {
    if (!receivedInitial) {
      if (!pending) {
        receivedInitial = true
      }
      outgoing = {
        type: 'snapshot',
        messages: frame.messages,
        hasMore: frame.hasMore ?? frame.messages.length >= (limit ?? 300),
        ...(frame.error ? { error: frame.error } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(frame.currentRequests ? { currentRequests: frame.currentRequests } : {}),
        ...(pending ? { pending: true } : {})
      }
    } else if (frame.type === 'snapshot') {
      outgoing = {
        type: 'snapshot',
        messages: frame.messages,
        hasMore: frame.hasMore ?? false,
        ...(frame.error ? { error: frame.error } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(frame.currentRequests ? { currentRequests: frame.currentRequests } : {}),
        ...(pending ? { pending: true } : {})
      }
    } else {
      outgoing =
        frame.type === 'replacement'
          ? {
              type: 'replacement',
              messages: frame.messages,
              hasMore: frame.hasMore ?? false,
              ...(lifecycle ? { lifecycle } : {}),
              ...(frame.currentRequests ? { currentRequests: frame.currentRequests } : {})
            }
          : {
              type: 'appended',
              messages: frame.messages,
              ...(lifecycle ? { lifecycle } : {}),
              ...(frame.currentRequests ? { currentRequests: frame.currentRequests } : {})
            }
    }
  } else if (!receivedInitial) {
    // Settle unrecognized successful payloads with an empty snapshot/error so loading cannot remain stuck.
    receivedInitial = true
    outgoing = {
      type: 'snapshot',
      messages: [],
      hasMore: false,
      ...(frame?.error ? { error: frame.error } : {})
    }
  }
  return { receivedInitial, frame: outgoing }
}
