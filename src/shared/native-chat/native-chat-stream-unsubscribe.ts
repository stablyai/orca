// Echo the exact cleanup token or watchers leak across view/session switches; older subscriptions use agent:sessionId.

export type NativeChatUnsubscribeRpc = {
  method: 'nativeChat.unsubscribe'
  params: { subscriptionId: string }
}

// Isolate concurrent views so teardown cannot evict another subscription.
export function buildNativeChatSubscriptionId(
  agent: string,
  sessionId: string,
  instance?: string
): string {
  return instance ? `${agent}:${sessionId}:${instance}` : `${agent}:${sessionId}`
}

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
