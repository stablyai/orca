// Why: the runtime keys a native-chat transcript fs-watcher by the cleanup token
// `agent:sessionId`. A subscribing client must echo that exact token on
// `nativeChat.unsubscribe` so the watcher is closed when the chat view toggles
// off (not just on socket close) — otherwise watchers leak per session-switch.
// Both the web runtime client and mobile use this single key shape; centralizing
// it here keeps the token from drifting between the two surfaces.

export type NativeChatUnsubscribeRpc = {
  method: 'nativeChat.unsubscribe'
  params: { subscriptionId: string }
}

/** The cleanup token the server keys the transcript watcher under. */
export function buildNativeChatSubscriptionId(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`
}

/** The unsubscribe RPC frame a client sends on teardown to close the watcher. */
export function buildNativeChatUnsubscribe(
  agent: string,
  sessionId: string,
  subscriptionId?: string
): NativeChatUnsubscribeRpc {
  return {
    method: 'nativeChat.unsubscribe',
    params: { subscriptionId: subscriptionId ?? buildNativeChatSubscriptionId(agent, sessionId) }
  }
}
