// Echo the exact subscription cleanup token on unsubscribe or fs-watchers leak until socket close across view/session switches.
// Share token construction across web/mobile; legacy fallback is agent:sessionId.

export type NativeChatUnsubscribeRpc = {
  method: 'nativeChat.unsubscribe'
  params: { subscriptionId: string }
}

/** instance isolates concurrent views of the same chat on one connection so teardown cannot evict another subscription. */
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
