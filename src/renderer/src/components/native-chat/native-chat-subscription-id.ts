let subscriptionCounter = 0

export function nextNativeChatSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}
