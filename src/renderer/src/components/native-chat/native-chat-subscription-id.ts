let subscriptionCounter = 0

/** Unique per live transcript stream, echoed on every frame so panes never cross-talk. */
export function nextNativeChatSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}
