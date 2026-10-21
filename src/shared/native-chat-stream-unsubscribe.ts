// Why: the runtime keys a native-chat transcript fs-watcher by the client's cleanup token
// (`agent:sessionId` when none is sent). A subscribing client must echo that exact token on
// `nativeChat.unsubscribe` so the watcher is closed when the chat view toggles off (not just on
// socket close) — otherwise watchers leak per session-switch. Centralizing the key shape keeps the
// token from drifting between the web runtime client and mobile.

export type NativeChatUnsubscribeRpc = {
  method: 'nativeChat.unsubscribe'
  params: { subscriptionId: string }
}

/** The cleanup token the server keys the transcript watcher under. An `instance` makes it one
 *  subscription's own, so two views of the same chat on one connection never evict each other. */
export function buildNativeChatSubscriptionId(
  agent: string,
  sessionId: string,
  instance?: string
): string {
  return instance ? `${agent}:${sessionId}:${instance}` : `${agent}:${sessionId}`
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
